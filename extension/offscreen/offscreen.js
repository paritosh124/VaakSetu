// Offscreen document — runs in a hidden page so it can hold MediaStreams,
// MediaRecorders, and an AudioContext (things a service worker can't).
//
// Responsibilities:
//  • Capture tab audio (customer voice) via the streamId passed from background
//  • Capture mic audio (agent voice) via getUserMedia
//  • Pipe tab audio to speakers so the call stays audible while we listen in
//  • On push-to-talk events, record a blob from the right source and run it
//    through the translation pipeline, then play the translated TTS
//  • Send transcript / status events back to the widget (via background)
import { translateAudio } from '../lib/pipeline.js';
import { getLang } from '../lib/config.js';

let config = null;          // { tabId, agentLang, customerLang, agentVoice, customerVoice }
let tabStream = null;       // MediaStream from tabCapture (customer side)
let micStream = null;       // MediaStream from getUserMedia (agent side)
let passthroughCtx = null;  // AudioContext piping tabStream → speakers
let recorder = null;
let recording = null;       // 'customer' | 'agent' | null
let chunks = [];

function post(ev, extra = {}) {
  if (!config?.tabId) return;
  chrome.runtime.sendMessage({ to: 'widget', tabId: config.tabId, event: ev, ...extra }).catch(() => {});
}

async function ensureTabStream(streamId) {
  if (tabStream) return tabStream;
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId },
    },
    video: false,
  });
  // Tab capture mutes the tab by default — route it back to the speakers.
  passthroughCtx = new AudioContext();
  const src = passthroughCtx.createMediaStreamSource(tabStream);
  src.connect(passthroughCtx.destination);
  return tabStream;
}

async function ensureMicStream() {
  if (micStream) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
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

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

async function startRecording(who) {
  if (recording) return; // already capturing

  let stream;
  try {
    stream = who === 'customer'
      ? await ensureTabStream(config?.streamId)
      : await ensureMicStream();
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

  // Who speaks → who hears (choose sourceLang, targetLang, voice accordingly).
  const sourceLang = who === 'customer' ? config.customerLang : config.agentLang;
  const targetLang = who === 'customer' ? config.agentLang    : config.customerLang;
  // Voice follows the listener (same rule as the webapp).
  const voiceGender = who === 'customer' ? config.agentVoice : config.customerVoice;

  const srcLabel = `${getLang(sourceLang).native} (${who === 'customer' ? 'Customer' : 'Agent'})`;
  const tgtLabel = `${getLang(targetLang).native} (${who === 'customer' ? 'Agent' : 'Customer'})`;
  const messageId = Date.now();

  try {
    const result = await translateAudio({
      audioBlob: blob,
      sourceLang, targetLang, voiceGender,
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

function stopAll() {
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
  if (msg?.to !== 'offscreen') return; // ignore cross-chatter
  (async () => {
    try {
      if (msg.cmd === 'init')            await init(msg);
      else if (msg.cmd === 'recordCustomer') await startRecording('customer');
      else if (msg.cmd === 'recordAgent')    await startRecording('agent');
      else if (msg.cmd === 'stopRecord')     await stopRecording();
      else if (msg.cmd === 'stop')           stopAll();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true;
});
