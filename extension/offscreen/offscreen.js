// Offscreen document — the only context that can hold MediaStreams in MV3.
//
// Responsibilities:
//   • Capture tab audio (customer) and mic audio (agent).
//   • Pipe tab audio to speakers so the call stays audible.
//   • Push-to-talk: start/stop recording on command, run batch pipeline.
//   • Go Live (hands-free): silence-detect on both streams; while someone
//     speaks, stream audio to Sarvam WebSocket STT and emit partials. On
//     silence, stop the streamer, grab the final pivot, run translate+TTS.
//     Queue turns so simultaneous speech doesn't overlap.
//   • Route TTS playback to a user-selected sinkId (VB-Cable etc.).
import { translateAudio, pivotToSpeech } from '../lib/pipeline.js';
import { getLang, isIndianLang } from '../lib/config.js';
import { SarvamStreamingSTT, supportsStreamingSTT } from '../lib/api/sarvam-streaming.js';

let config = null;
let tabStream = null;
let micStream = null;
let passthroughCtx = null;

// Push-to-talk state
let recorder = null;
let recording = null;
let chunks = [];

// Go Live state
let goLive = false;
let vadLoops = {};           // { customer, agent }
let turnQueue = [];          // { who, pivotPromise, streamer, mediaRecorder, blobPromise }
let processing = false;
let activeCapture = null;    // { who, streamer, mediaRecorder, startedAt, chunks, blobPromise, blobResolve }

function post(ev, extra = {}) {
  if (!config?.tabId) return;
  chrome.runtime.sendMessage({ to: 'widget', tabId: config.tabId, event: ev, ...extra }).catch(() => {});
}

async function ensureTabStream(streamId) {
  if (tabStream) return tabStream;
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
  passthroughCtx = new AudioContext();
  const src = passthroughCtx.createMediaStreamSource(tabStream);
  src.connect(passthroughCtx.destination);
  return tabStream;
}

async function ensureMicStream() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  return micStream;
}

async function init(cfg) {
  config = cfg;
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
  const voiceGender = who === 'customer' ? config.agentVoice : config.customerVoice;

  const srcLabel = `${getLang(sourceLang).native} (${who === 'customer' ? 'Customer' : 'Agent'})`;
  const tgtLabel = `${getLang(targetLang).native} (${who === 'customer' ? 'Agent' : 'Customer'})`;
  const messageId = Date.now();

  try {
    const result = await translateAudio({
      audioBlob: blob,
      sourceLang, targetLang, voiceGender,
      sinkId: config.outputSinkId,
      onStep: (id, msg) => post('status', { text: msg }),
      onText: (pivotText, translatedText) => {
        post('message', { id: messageId, who, srcLabel, tgtLabel, pivotText, translatedText });
      },
    });
    await result.audioPromise;
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

const SILENCE_THRESHOLD = 12;
const SILENCE_MS = 1500;
const MIN_SPEECH_MS = 400;

function createVadLoop({ stream, onSpeechStart, onSpeechEnd }) {
  const ac = new AudioContext();
  const src = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);

  const buf = new Uint8Array(analyser.fftSize);
  let speakingSince = 0;
  let silentSince = 0;
  let speaking = false;
  let armed = false;
  let paused = false;

  const interval = setInterval(() => {
    if (paused) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i] - 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    const active = rms >= SILENCE_THRESHOLD;

    if (active) {
      if (!speaking) { speaking = true; speakingSince = now; }
      silentSince = 0;
      if (!armed && now - speakingSince >= MIN_SPEECH_MS) {
        armed = true;
        onSpeechStart?.();
      }
    } else {
      if (speaking && !silentSince) silentSince = now;
      if (armed && silentSince && now - silentSince >= SILENCE_MS) {
        speaking = false;
        armed = false;
        silentSince = 0;
        onSpeechEnd?.();
      } else if (!armed) {
        speaking = false;
        silentSince = 0;
      }
    }
  }, 60);

  return {
    stop() {
      clearInterval(interval);
      try { src.disconnect(); } catch {}
      try { analyser.disconnect(); } catch {}
      try { ac.close(); } catch {}
    },
    pause() { paused = true; speaking = false; armed = false; silentSince = 0; },
    resume() { paused = false; speaking = false; armed = false; silentSince = 0; },
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
  activeCapture = null;
  post('goLive', { on: true });
  post('status', { text: '● Listening' });

  vadLoops.customer = createVadLoop({
    stream: tabStream,
    onSpeechStart: () => beginCapture('customer'),
    onSpeechEnd:   () => endCapture('customer'),
  });
  vadLoops.agent = createVadLoop({
    stream: micStream,
    onSpeechStart: () => beginCapture('agent'),
    onSpeechEnd:   () => endCapture('agent'),
  });
}

async function stopGoLive() {
  if (!goLive) return;
  goLive = false;
  for (const k of Object.keys(vadLoops)) vadLoops[k]?.stop?.();
  vadLoops = {};
  if (activeCapture) {
    try { await activeCapture.streamer?.destroy?.(); } catch {}
    try { activeCapture.mediaRecorder?.stop?.(); } catch {}
    activeCapture = null;
  }
  turnQueue = [];
  processing = false;
  post('goLive', { on: false });
  post('status', { text: '' });
  post('partial', { text: '', clear: true });
}

async function beginCapture(who) {
  if (!goLive) return;
  if (activeCapture) return; // one streamer at a time — ignore the late starter
  const stream = who === 'customer' ? tabStream : micStream;
  const sourceLang = who === 'customer' ? config.customerLang : config.agentLang;

  const cap = { who, sourceLang, streamer: null, mediaRecorder: null, parts: [], blobPromise: null, blobResolve: null };
  activeCapture = cap;
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

  // Streaming STT only supports Sarvam's Indian language set.
  if (isIndianLang(sourceLang)) {
    const mode = sourceLang === 'en-IN' ? 'transcribe' : 'translate';
    cap.streamer = new SarvamStreamingSTT({
      languageCode: sourceLang,
      mode,
      onPartial: (text) => post('partial', { who, text }),
    });
    try {
      await cap.streamer.start(stream);
    } catch (err) {
      cap.streamer = null; // streaming failed — fall through to batch on endCapture
      console.warn('[offscreen] streaming start failed, will use batch:', err.message);
    }
  }
}

async function endCapture(who) {
  const cap = activeCapture;
  if (!cap || cap.who !== who || !goLive) {
    // Same person's VAD re-firing or stale event — ignore.
    return;
  }
  activeCapture = null;

  let pivotText = '';
  try { if (cap.streamer) pivotText = await cap.streamer.stop(); } catch {}

  let blob = null;
  try {
    if (cap.mediaRecorder && cap.mediaRecorder.state !== 'inactive') cap.mediaRecorder.stop();
    blob = await cap.blobPromise;
  } catch {}

  turnQueue.push({ who, pivotText, blob });
  post('partial', { text: '', clear: true });
  pumpQueue();
}

async function pumpQueue() {
  if (processing || !goLive) return;
  const turn = turnQueue.shift();
  if (!turn) return;
  processing = true;

  const { who, pivotText, blob } = turn;
  const sourceLang = who === 'customer' ? config.customerLang : config.agentLang;
  const targetLang = who === 'customer' ? config.agentLang    : config.customerLang;
  const voiceGender = who === 'customer' ? config.agentVoice : config.customerVoice;
  const srcLabel = `${getLang(sourceLang).native} (${who === 'customer' ? 'Customer' : 'Agent'})`;
  const tgtLabel = `${getLang(targetLang).native} (${who === 'customer' ? 'Agent' : 'Customer'})`;
  const messageId = Date.now();

  // Pause the opposite side's VAD so our TTS playback doesn't retrigger.
  const other = who === 'customer' ? 'agent' : 'customer';
  vadLoops[other]?.pause?.();
  post('status', { text: `● Translating (${who})…` });

  try {
    if (pivotText) {
      // Fast path: streaming STT already produced English pivot.
      const result = await pivotToSpeech({
        pivotText, sourceLang, targetLang, voiceGender,
        sinkId: config.outputSinkId,
        onStep: (id, msg) => post('status', { text: msg }),
        onText: (pivot, translated) => {
          post('message', { id: messageId, who, srcLabel, tgtLabel, pivotText: pivot, translatedText: translated });
        },
      });
      await result.audioPromise;
    } else if (blob && blob.size >= 1000) {
      // Intl source or streaming failed — batch pipeline off the MediaRecorder blob.
      const result = await translateAudio({
        audioBlob: blob,
        sourceLang, targetLang, voiceGender,
        sinkId: config.outputSinkId,
        onStep: (id, msg) => post('status', { text: msg }),
        onText: (pivot, translated) => {
          post('message', { id: messageId, who, srcLabel, tgtLabel, pivotText: pivot, translatedText: translated });
        },
      });
      await result.audioPromise;
    } else {
      post('status', { text: 'Too short — keep speaking.' });
    }
  } catch (err) {
    post('error', { error: err.message || String(err) });
  } finally {
    post('status', { text: goLive ? '● Listening' : '' });
    vadLoops[other]?.resume?.();
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
  try { passthroughCtx?.close(); } catch {}
  tabStream = micStream = passthroughCtx = null;
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
