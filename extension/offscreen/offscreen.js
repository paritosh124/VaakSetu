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

async function init(cfg) {
  config = cfg;
  try {
    // Tab audio. Without chromeMediaSource:'tab' we'd get the wrong stream.
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: cfg.streamId,
        },
      },
      video: false,
    });

    // Keep the call audible — tab capture by itself mutes the tab, so fan it
    // back out to the speakers via an AudioContext.
    passthroughCtx = new AudioContext();
    const src = passthroughCtx.createMediaStreamSource(tabStream);
    src.connect(passthroughCtx.destination);

    // Agent mic.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    post('ready', {
      agentLang: cfg.agentLang,
      customerLang: cfg.customerLang,
    });
  } catch (err) {
    post('error', { error: `Audio capture failed: ${err.message || err}` });
    throw err;
  }
}

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

function startRecording(who) {
  if (recording) return; // already capturing
  const stream = who === 'customer' ? tabStream : micStream;
  if (!stream) { post('error', { error: 'Audio not initialised.' }); return; }

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
      else if (msg.cmd === 'recordCustomer') startRecording('customer');
      else if (msg.cmd === 'recordAgent')    startRecording('agent');
      else if (msg.cmd === 'stopRecord')     await stopRecording();
      else if (msg.cmd === 'stop')           stopAll();
      sendResponse({ ok: true });
    } catch (err) {
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true;
});
