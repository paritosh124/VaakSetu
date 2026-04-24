// Offscreen document — the only context that can hold MediaStreams in MV3.
//
// Responsibilities:
//   • Capture tab audio (customer) and mic audio (agent).
//   • Push-to-talk: start/stop recording on command, run batch pipeline.
//   • Go Live (hands-free): silence-detect on both streams; while someone
//     speaks, stream audio to Sarvam WebSocket STT and emit partials. On
//     silence, stop the streamer, grab the final pivot, run translate+TTS.
//     Queue turns so simultaneous speech doesn't overlap.
//   • Route TTS playback to a user-selected sinkId (VB-Cable etc.).
// The Meet tab itself is muted by background.js (chrome.tabs.update) so the
// agent hears only translated audio, never the raw customer voice.
import { translateAudio, pivotToSpeech, pivotToAudio, playBase64Audio } from '../lib/pipeline.js';
import { getLang, isIndianLang } from '../lib/config.js';
import { supportsStreamingSTT } from '../lib/api/sarvam-streaming.js';
import { SarvamSentenceStreamer } from '../lib/api/sarvam-sentence-streamer.js';

let config = null;
let tabStream = null;
let micStream = null;

// Per-turn sink lookup.
//   who === 'agent'    → agent spoke, translation goes to the CUSTOMER (via
//                        Meet's mic — so feed it into VB-Cable). Use sinkAgent.
//   who === 'customer' → customer spoke, translation goes to the AGENT's ears.
//                        Use sinkCustomer (headphones / default output).
function sinkFor(who) {
  if (!config) return 'default';
  return who === 'agent' ? (config.sinkAgent || 'default') : (config.sinkCustomer || 'default');
}

// Push-to-talk state
let recorder = null;
let recording = null;
let chunks = [];

// Go Live state
let goLive = false;
let vadLoops = {};                      // { customer, agent }
let turnQueue = [];                     // batch-fallback turns only
let processing = false;
// Per-speaker capture slots so both sides can run concurrently — a customer
// can interrupt / start their turn while the agent is still finishing.
let activeCaptures = { agent: null, customer: null };
// Per-direction playback chain. Agent-direction translation plays on
// sinkAgent (usually VCC → customer's Meet mic); customer-direction plays on
// sinkCustomer (usually headphones). They're independent audio devices, so
// their chains must be independent too — otherwise a long customer
// translation would block an agent-direction sentence from reaching the
// customer in time.
let playChains = { agent: Promise.resolve(), customer: Promise.resolve() };

// Cross-talk suppression — when both VADs fire within this window we treat
// it as acoustic leak (agent speakers bleeding into tab audio, or vice
// versa) and keep only the louder stream.
const CROSSTALK_WINDOW_MS = 250;
const CROSSTALK_RMS_DOMINANCE = 1.3;
let lastSpeechStartAt = { agent: 0, customer: 0 };

function post(ev, extra = {}) {
  if (!config?.tabId) return;
  chrome.runtime.sendMessage({ to: 'widget', tabId: config.tabId, event: ev, ...extra }).catch(() => {});
}

async function ensureTabStream(streamId) {
  if (tabStream) return tabStream;
  // getUserMedia with chromeMediaSource:'tab' captures the tab audio without
  // muting the tab — that was an older tabCapture.capture() behavior that no
  // longer holds for getMediaStreamId. We don't hook up a passthrough here:
  // background.js mutes the tab itself via chrome.tabs.update, which is the
  // clean way to keep the tab silent to the user while its audio still flows
  // into this stream for analysis.
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  return tabStream;
}

async function ensureMicStream() {
  if (micStream) return micStream;
  const devId = config?.micDeviceId;
  const audio = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  // Only pin a specific device when the user picked one explicitly.
  // `default` means "let Chrome pick the system default" — and Chrome picks
  // at track-creation time, so if the user later changes the OS default we
  // still capture from the one they intended when they clicked Start.
  if (devId && devId !== 'default') audio.deviceId = { exact: devId };
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio });
  } catch (err) {
    if (devId && devId !== 'default') {
      console.warn('[vaaksetu] mic deviceId unavailable, retrying with default:', err?.message);
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } else {
      throw err;
    }
  }
  const track = micStream.getAudioTracks()[0];
  console.log('[vaaksetu] mic captured from:', track?.label || '(unknown)');
  return micStream;
}

async function init(cfg) {
  config = cfg;
  console.log('[vaaksetu] offscreen init — sinkAgent:', cfg.sinkAgent, 'sinkCustomer:', cfg.sinkCustomer);
  let tabOk = false, micOk = false, firstErr = null;

  try { await ensureTabStream(cfg.streamId); tabOk = true; }
  catch (err) { firstErr = err; }
  try { await ensureMicStream(); micOk = true; }
  catch (err) { if (!firstErr) firstErr = err; }

  if (tabOk && micOk) {
    post('ready', { agentLang: cfg.agentLang, customerLang: cfg.customerLang });
  } else if (tabOk) {
    post('ready', { agentLang: cfg.agentLang, customerLang: cfg.customerLang });
    post('error', { error: `Mic not ready: ${firstErr?.message || firstErr}. Agent button will retry.` });
  } else {
    post('error', { error: `Audio capture failed: ${firstErr?.message || firstErr}` });
  }
}

// ─── Push-to-talk (batch) ───────────────────────────────────────────────────
function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

async function startRecording(who) {
  if (recording || goLive) return;
  let stream;
  try {
    stream = who === 'customer' ? await ensureTabStream(config?.streamId) : await ensureMicStream();
  } catch (err) {
    post('error', {
      error: who === 'agent'
        ? `Microphone blocked: ${err.message}. Open the extension popup, click Start again, and allow mic when prompted.`
        : `Tab audio unavailable: ${err.message}`,
    });
    return;
  }

  chunks = [];
  const mimeType = pickMimeType();
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  } catch (e) {
    post('error', { error: `MediaRecorder failed: ${e.message}` });
    return;
  }
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.start();
  recording = who;
  post('status', { text: `Listening (${who})…` });
}

async function stopRecording() {
  if (!recorder || !recording) return;
  const who = recording;
  const r = recorder;
  recording = null;
  recorder = null;

  await new Promise((resolve) => {
    r.onstop = () => resolve();
    try { r.stop(); } catch { resolve(); }
  });

  const type = (r.mimeType || 'audio/webm').split(';')[0];
  const blob = new Blob(chunks, { type });
  chunks = [];

  if (blob.size < 1000) {
    post('status', { text: 'Too short — hold the button while speaking.' });
    return;
  }

  await runBatchTurn({ who, blob });
}

async function runBatchTurn({ who, blob }) {
  const sourceLang = who === 'customer' ? config.customerLang : config.agentLang;
  const targetLang = who === 'customer' ? config.agentLang    : config.customerLang;
  // Speaker-preference: agentVoice is the voice used WHEN agent speaks (heard
  // by the customer); customerVoice is used when customer speaks (heard by
  // agent). Matches the popup's UI grouping ("Agent voice" is under "Agent
  // speaks") which is what users naturally expect.
  const voiceGender = who === 'agent' ? config.agentVoice : config.customerVoice;

  const srcLabel = `${getLang(sourceLang).native} (${who === 'customer' ? 'Customer' : 'Agent'})`;
  const tgtLabel = `${getLang(targetLang).native} (${who === 'customer' ? 'Agent' : 'Customer'})`;
  const messageId = Date.now();
  const t0 = Date.now();

  try {
    const result = await translateAudio({
      audioBlob: blob,
      sourceLang, targetLang, voiceGender,
      sinkId: sinkFor(who),
      onStep: (id, msg) => {
        console.log(`[vaaksetu timing ${who}] +${Date.now() - t0}ms ${msg}`);
        post('status', { text: msg });
      },
      onText: (pivotText, translatedText) => {
        post('message', { id: messageId, who, srcLabel, tgtLabel, pivotText, translatedText });
      },
    });
    const tReady = Date.now() - t0;
    await result.audioPromise;
    console.log(`[vaaksetu timing ${who}] READY +${tReady}ms | PLAYED +${Date.now() - t0}ms`);
    post('status', { text: '' });
  } catch (err) {
    post('error', { error: err.message || String(err) });
  }
}

// ─── Go Live — hands-free with streaming STT + VAD ─────────────────────────
//
// Lifecycle per turn:
//   1. VAD detects speech onset → open streaming STT (and batch MediaRecorder
//      as fallback for intl source), begin feeding audio.
//   2. While speaking, Sarvam emits partial transcripts — forwarded to widget
//      as a live transcript bubble.
//   3. VAD detects silence (1.5s) → stop streamer, take final transcript as
//      pivot text, enqueue the translate+TTS turn. The MediaRecorder blob is
//      the backup path for intl sources (Groq Whisper batch STT).
//   4. Queue worker pops turns one at a time, runs pivotToSpeech (or full
//      batch pipeline if intl source), plays TTS to the selected sink.
//   5. During TTS playback, the opposite VAD is paused so the translation
//      doesn't re-trigger a turn through the call audio.

// VAD tuning:
//   SILENCE_THRESHOLD  — minimum RMS to count a tick as active. Dropped to 6
//                        because AGC-processed mic signals often sit around
//                        8-15 even during speech.
//   MIN_SPEECH_MS      — accumulated active time (NOT consecutive) before
//                        arming. Brief inter-word pauses are tolerated.
//   SILENCE_MS         — sustained silence that closes the turn. 900ms is the
//                        biggest latency lever in the pipeline — user sees a
//                        translation this much faster after they stop speaking.
//   GAP_TOLERANCE_MS   — how long an inactive run has to be before we reset
//                        the active accumulator (only while not yet armed).
const SILENCE_THRESHOLD = 6;
const SILENCE_MS = 900;
const MIN_SPEECH_MS = 320;
const GAP_TOLERANCE_MS = 250;
const NO_SIGNAL_WARN_MS = 6000;

function createVadLoop({ who, stream, onSpeechStart, onSpeechEnd, onNoSignal }) {
  const ac = new AudioContext();
  // Offscreen docs don't inherit the widget's click as a user gesture, so
  // new AudioContext() may be created in "suspended" state. Without
  // resume(), the analyser never processes samples and VAD never fires.
  if (ac.state === 'suspended') {
    ac.resume().catch((e) => console.warn('[vaaksetu] VAD ctx resume failed', who, e));
  }
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  // Terminate graph into a muted gain → destination. Some Chromium builds
  // prune subgraphs that don't reach destination, which would freeze the
  // analyser data.
  const mute = ac.createGain();
  mute.gain.value = 0;
  src.connect(analyser);
  analyser.connect(mute);
  mute.connect(ac.destination);

  const buf = new Uint8Array(analyser.fftSize);
  let activeMs = 0;
  let silentMs = 0;
  let armed = false;
  let paused = false;
  let lastTickAt = Date.now();
  let lastDebugAt = 0;
  let peakRms = 0;
  let lastRms = 0;
  let noSignalMs = 0;
  let warnedNoSignal = false;

  const interval = setInterval(() => {
    const now = Date.now();
    // Cap dt so a backgrounded tab doesn't dump one massive silent delta
    // onto silentMs and falsely end a speech segment.
    const dt = Math.min(200, now - lastTickAt);
    lastTickAt = now;
    if (paused) return;

    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] - 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    lastRms = rms;
    peakRms = Math.max(peakRms, rms);
    const active = rms >= SILENCE_THRESHOLD;

    if (now - lastDebugAt >= 2000) {
      console.log(`[vaaksetu VAD ${who}] state=${ac.state} peakRms=${peakRms.toFixed(1)} threshold=${SILENCE_THRESHOLD} armed=${armed} activeMs=${activeMs}`);
      if (peakRms < 1.5) noSignalMs += (now - lastDebugAt); else noSignalMs = 0;
      if (!warnedNoSignal && noSignalMs >= NO_SIGNAL_WARN_MS) {
        warnedNoSignal = true;
        console.warn(`[vaaksetu VAD ${who}] NO SIGNAL — check popup device picker`);
        onNoSignal?.();
      }
      lastDebugAt = now;
      peakRms = 0;
    }

    if (active) {
      activeMs += dt;
      silentMs = 0;
      if (!armed && activeMs >= MIN_SPEECH_MS) {
        armed = true;
        console.log(`[vaaksetu VAD ${who}] speech-start rms=${rms.toFixed(1)} activeMs=${activeMs}`);
        onSpeechStart?.();
      }
    } else {
      silentMs += dt;
      if (!armed) {
        // Tolerate brief pauses between words; only reset the accumulator
        // when silence runs longer than GAP_TOLERANCE_MS.
        if (silentMs > GAP_TOLERANCE_MS) activeMs = 0;
      } else if (silentMs >= SILENCE_MS) {
        armed = false;
        activeMs = 0;
        silentMs = 0;
        console.log(`[vaaksetu VAD ${who}] speech-end`);
        onSpeechEnd?.();
      }
    }
  }, 60);

  return {
    stop() {
      clearInterval(interval);
      try { src.disconnect(); } catch {}
      try { analyser.disconnect(); } catch {}
      try { mute.disconnect(); } catch {}
      try { ac.close(); } catch {}
    },
    pause() { paused = true; activeMs = 0; silentMs = 0; armed = false; },
    resume() {
      paused = false;
      activeMs = 0;
      silentMs = 0;
      armed = false;
      lastTickAt = Date.now();
    },
    // Expose the last-measured RMS so the offscreen loop can compare the two
    // streams on simultaneous speech-start and ignore the quieter (echo/leak).
    rms: () => lastRms,
  };
}

async function startGoLive() {
  if (goLive) return;
  if (!supportsStreamingSTT()) {
    post('error', { error: 'Streaming STT not supported in this browser.' });
    return;
  }
  try {
    await ensureTabStream(config?.streamId);
    await ensureMicStream();
  } catch (err) {
    post('error', { error: `Go Live needs mic + tab audio: ${err.message}` });
    return;
  }

  goLive = true;
  turnQueue = [];
  processing = false;
  activeCaptures = { agent: null, customer: null };
  playChains = { agent: Promise.resolve(), customer: Promise.resolve() };
  lastSpeechStartAt = { agent: 0, customer: 0 };
  post('goLive', { on: true });
  post('status', { text: '● Listening' });

  vadLoops.customer = createVadLoop({
    who: 'customer',
    stream: tabStream,
    onSpeechStart: () => beginCapture('customer'),
    onSpeechEnd:   () => endCapture('customer'),
    onNoSignal:    () => post('error', {
      error: 'No customer audio reaching the extension. Is the Meet tab active and unmuted at the OS level?',
    }),
  });
  vadLoops.agent = createVadLoop({
    who: 'agent',
    stream: micStream,
    onSpeechStart: () => beginCapture('agent'),
    onSpeechEnd:   () => endCapture('agent'),
    onNoSignal:    () => post('error', {
      error: 'No mic signal. Open the popup → "Your microphone" → pick your physical mic (not CABLE Output).',
    }),
  });
}

async function stopGoLive() {
  if (!goLive) return;
  goLive = false;
  for (const k of Object.keys(vadLoops)) vadLoops[k]?.stop?.();
  vadLoops = {};
  for (const k of Object.keys(activeCaptures)) {
    const cap = activeCaptures[k];
    if (!cap) continue;
    try { await cap.streamer?.destroy?.(); } catch {}
    try { cap.mediaRecorder?.stop?.(); } catch {}
    activeCaptures[k] = null;
  }
  turnQueue = [];
  processing = false;
  post('goLive', { on: false });
  post('status', { text: '' });
  post('partial', { text: '', clear: true });
}

async function beginCapture(who) {
  if (!goLive) return;
  if (activeCaptures[who]) return; // already capturing this side's turn

  // Cross-talk check — if the OTHER side fired speech-start very recently
  // and is currently louder than us, the sound we're hearing is almost
  // certainly a leak (agent's voice bleeding into tab audio through
  // speakers, or translation output bleeding into mic). Skip this side.
  const other = who === 'customer' ? 'agent' : 'customer';
  const otherStart = lastSpeechStartAt[other];
  if (otherStart && Date.now() - otherStart < CROSSTALK_WINDOW_MS) {
    const myRms    = vadLoops[who]?.rms?.()    ?? 0;
    const otherRms = vadLoops[other]?.rms?.()  ?? 0;
    if (otherRms > myRms * CROSSTALK_RMS_DOMINANCE) {
      console.log(`[vaaksetu cross-talk] dropped ${who} speech-start (otherRms=${otherRms.toFixed(1)} > myRms=${myRms.toFixed(1)} × ${CROSSTALK_RMS_DOMINANCE})`);
      return;
    }
  }
  lastSpeechStartAt[who] = Date.now();

  const stream = who === 'customer' ? tabStream : micStream;
  const sourceLang = who === 'customer' ? config.customerLang : config.agentLang;
  const targetLang = who === 'customer' ? config.agentLang    : config.customerLang;
  const voiceGender = who === 'agent' ? config.agentVoice : config.customerVoice;
  const srcLabel = `${getLang(sourceLang).native} (${who === 'customer' ? 'Customer' : 'Agent'})`;
  const tgtLabel = `${getLang(targetLang).native} (${who === 'customer' ? 'Agent' : 'Customer'})`;

  const cap = {
    who, sourceLang, targetLang, voiceGender, srcLabel, tgtLabel,
    streamer: null, mediaRecorder: null, parts: [],
    blobPromise: null, blobResolve: null,
    startedAt: Date.now(),
    firstAudioAt: 0,
    sentenceIndex: 0,
  };
  activeCaptures[who] = cap;
  post('status', { text: `● Listening (${who})…` });

  // MediaRecorder always runs in parallel — it's the fallback for intl source
  // (no streaming STT for non-Indian) and a safety net if the WebSocket drops.
  try {
    const mime = pickMimeType();
    cap.mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    cap.mediaRecorder.ondataavailable = (e) => { if (e.data?.size) cap.parts.push(e.data); };
    cap.blobPromise = new Promise((resolve) => { cap.blobResolve = resolve; });
    cap.mediaRecorder.onstop = () => {
      const type = (cap.mediaRecorder.mimeType || 'audio/webm').split(';')[0];
      cap.blobResolve(new Blob(cap.parts, { type }));
    };
    cap.mediaRecorder.start();
  } catch (err) {
    post('error', { error: `Recorder failed: ${err.message}` });
  }

  // Streaming STT only supports Sarvam's Indian language set. When available,
  // we fire translate+TTS PER SENTENCE so the listener hears the first
  // translated sentence while the speaker is still producing the next.
  if (isIndianLang(sourceLang)) {
    const mode = sourceLang === 'en-IN' ? 'transcribe' : 'translate';
    cap.streamer = new SarvamSentenceStreamer({
      languageCode: sourceLang,
      mode,
      onPartial: (text) => post('partial', { who, text }),
      onSentence: (sentence, isFinal) => handleSentence(cap, sentence, isFinal),
    });
    try {
      await cap.streamer.start(stream);
    } catch (err) {
      cap.streamer = null; // streaming failed — fall through to batch on endCapture
      console.warn('[offscreen] streaming start failed, will use batch:', err.message);
    }
  }
}

// Fires a sentence through translate+TTS immediately; playback is chained to
// preserve order across sentences within the same turn. Translation and TTS
// for sentence N run in parallel with the playback of sentence N-1.
function handleSentence(cap, sentence, isFinal) {
  const idx = cap.sentenceIndex++;
  const tStart = Date.now();
  console.log(`[vaaksetu sentence ${cap.who} #${idx}] "${sentence}" isFinal=${isFinal}`);
  post('status', { text: `● Translating (${cap.who})…` });

  // Kick off translate + TTS immediately (non-blocking).
  const audioPromise = pivotToAudio({
    pivotText: sentence,
    targetLang: cap.targetLang,
    voiceGender: cap.voiceGender,
    onText: (pivot, translated) => {
      console.log(`[vaaksetu text ${cap.who} #${idx}] pivot: ${JSON.stringify(pivot)} → ${JSON.stringify(translated)}`);
      post('message', {
        id: Date.now() + idx,
        who: cap.who,
        srcLabel: cap.srcLabel,
        tgtLabel: cap.tgtLabel,
        pivotText: pivot,
        translatedText: translated,
      });
    },
  }).catch((err) => {
    post('error', { error: err.message || String(err) });
    return { audios: [] };
  });

  // Chain playback on the PER-DIRECTION chain so sentences play in order
  // within a direction (agent-to-customer stays ordered) but the two
  // directions run concurrently on their separate output devices.
  playChains[cap.who] = playChains[cap.who].then(async () => {
    const { audios = [] } = await audioPromise;
    if (!cap.firstAudioAt) {
      cap.firstAudioAt = Date.now();
      console.log(`[vaaksetu sentence ${cap.who} #${idx}] first audio at +${cap.firstAudioAt - tStart}ms after sentence detected`);
    }
    for (const b64 of audios) {
      if (b64) await playBase64Audio(b64, { sinkId: sinkFor(cap.who) });
    }
  }).catch((err) => console.error('[vaaksetu playChain]', err));
}

async function endCapture(who) {
  const cap = activeCaptures[who];
  if (!cap || !goLive) return; // stale event
  activeCaptures[who] = null;

  const endedAt = Date.now();

  let streamedOk = false;
  if (cap.streamer) {
    const tStop = Date.now();
    try {
      await cap.streamer.stop();
      streamedOk = true;
    } catch (e) { console.warn('[offscreen] streamer.stop failed', e?.message); }
    console.log(`[vaaksetu timing ${who}] streamer.stop() took ${Date.now() - tStop}ms`);
  }

  let blob = null;
  try {
    if (cap.mediaRecorder && cap.mediaRecorder.state !== 'inactive') cap.mediaRecorder.stop();
    blob = await cap.blobPromise;
  } catch {}

  post('partial', { who, text: '', clear: true });

  if (streamedOk && cap.sentenceIndex > 0) {
    // Sentences already fired incrementally during capture. We do NOT block
    // the opposite speaker here — each direction has its own playChain and
    // runs concurrently (agent can keep speaking while customer's current
    // translation is still playing, and vice versa).
    playChains[who].catch(() => {}).finally(() => {
      console.log(`[vaaksetu timing ${who}] PLAYED +${Date.now() - endedAt}ms (streamed, ${cap.sentenceIndex} sentences)`);
    });
    if (!activeCaptures.agent && !activeCaptures.customer) {
      post('status', { text: goLive ? '● Listening' : '' });
    }
    return;
  }

  // Streaming failed or produced nothing — batch-pipeline the blob.
  turnQueue.push({ who, pivotText: '', blob, endedAt });
  pumpQueue();
}

async function pumpQueue() {
  if (processing || !goLive) return;
  const turn = turnQueue.shift();
  if (!turn) return;
  processing = true;

  const { who, pivotText, blob, endedAt } = turn;
  const sourceLang = who === 'customer' ? config.customerLang : config.agentLang;
  const targetLang = who === 'customer' ? config.agentLang    : config.customerLang;
  // Speaker-preference (see runBatchTurn).
  const voiceGender = who === 'agent' ? config.agentVoice : config.customerVoice;
  const srcLabel = `${getLang(sourceLang).native} (${who === 'customer' ? 'Customer' : 'Agent'})`;
  const tgtLabel = `${getLang(targetLang).native} (${who === 'customer' ? 'Agent' : 'Customer'})`;
  const messageId = Date.now();

  // NOTE: no longer pausing the opposite VAD during playback. Concurrent
  // captures + playback are allowed so a customer can start speaking while
  // the agent's translation is still finishing. Cross-talk suppression in
  // beginCapture() handles the feedback case via RMS comparison.
  post('status', { text: `● Translating (${who})…` });

  try {
    // End-to-end latency — from VAD speech-end to end-of-playback.
    const latencyStep = (msg) =>
      console.log(`[vaaksetu timing ${who}] +${Date.now() - endedAt}ms ${msg}`);
    const onStep = (_id, msg) => { latencyStep(msg); post('status', { text: msg }); };
    const onText = (pivot, translated) => {
      // Log both so the user can tell STT-quality issues from translation-quality.
      console.log(`[vaaksetu text ${who}] pivot (${sourceLang}): ${JSON.stringify(pivot)}`);
      console.log(`[vaaksetu text ${who}] final (${targetLang}): ${JSON.stringify(translated)}`);
      post('message', { id: messageId, who, srcLabel, tgtLabel, pivotText: pivot, translatedText: translated });
    };

    if (pivotText) {
      // Fast path: streaming STT already produced English pivot.
      latencyStep('STT done (streaming)');
      const result = await pivotToSpeech({
        pivotText, sourceLang, targetLang, voiceGender,
        sinkId: sinkFor(who), onStep, onText,
      });
      const tReady = Date.now() - endedAt;
      await result.audioPromise;
      console.log(`[vaaksetu timing ${who}] READY +${tReady}ms | PLAYED +${Date.now() - endedAt}ms`);
    } else if (blob && blob.size >= 1000) {
      // Intl source or streaming failed — batch pipeline off the MediaRecorder blob.
      const result = await translateAudio({
        audioBlob: blob,
        sourceLang, targetLang, voiceGender,
        sinkId: sinkFor(who), onStep, onText,
      });
      const tReady = Date.now() - endedAt;
      await result.audioPromise;
      console.log(`[vaaksetu timing ${who}] READY +${tReady}ms | PLAYED +${Date.now() - endedAt}ms`);
    } else {
      post('status', { text: 'Too short — keep speaking.' });
    }
  } catch (err) {
    post('error', { error: err.message || String(err) });
  } finally {
    post('status', { text: goLive ? '● Listening' : '' });
    processing = false;
    if (goLive) setTimeout(pumpQueue, 150);
  }
}

function stopAll() {
  stopGoLive();
  try { recorder?.stop?.(); } catch {}
  recorder = null;
  recording = null;
  chunks = [];
  try { tabStream?.getTracks()?.forEach((t) => t.stop()); } catch {}
  try { micStream?.getTracks()?.forEach((t) => t.stop()); } catch {}
  tabStream = micStream = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.to !== 'offscreen') return;
  (async () => {
    try {
      if (msg.cmd === 'init')                 await init(msg);
      else if (msg.cmd === 'recordCustomer')  await startRecording('customer');
      else if (msg.cmd === 'recordAgent')     await startRecording('agent');
      else if (msg.cmd === 'stopRecord')      await stopRecording();
      else if (msg.cmd === 'goLive')          await startGoLive();
      else if (msg.cmd === 'stopGoLive')      await stopGoLive();
      else if (msg.cmd === 'stop')            stopAll();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true;
});
