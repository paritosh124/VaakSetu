// Sarvam API wrapper for the Chrome extension.
// Always hits the deployed Vercel serverless proxy — no browser-side API key.
import { API_BASE } from '../config.js';

const toSTTCode    = (c) => c === 'od-IN' ? 'or-IN' : c;
const toNonSTTCode = (c) => c === 'or-IN' ? 'od-IN' : c;

export async function speechToText({ audioBlob, languageCode, mode = 'transcribe' }) {
  const fd = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
  fd.append('file', audioBlob, `audio.${ext}`);
  fd.append('model', 'saaras:v3');
  fd.append('mode', mode);
  fd.append('language_code', toSTTCode(languageCode));

  const res = await fetch(`${API_BASE}/speech-to-text`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Sarvam STT failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);

  const data = await res.json();
  return { transcript: data.transcript, detectedLanguage: data.language_code };
}

// Mayura's `input` field caps at 1000 chars per request. Long utterances need
// to be chunked and recombined; sentence-boundary splits keep each chunk
// translatable in isolation without losing meaning.
const MAX_TRANSLATE_CHARS = 900;

async function translateOne({ text, sourceLang, targetLang }) {
  const res = await fetch(`${API_BASE}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: text,
      source_language_code: toNonSTTCode(sourceLang),
      target_language_code: toNonSTTCode(targetLang),
      model: 'mayura:v1',
      mode: 'modern-colloquial',
    }),
  });
  if (!res.ok) throw new Error(`Sarvam translate failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  const data = await res.json();
  return data.translated_text ?? data.translation ?? data.output ?? '';
}

export async function translateText({ text, sourceLang, targetLang }) {
  const chunks = chunkText(text, MAX_TRANSLATE_CHARS);
  if (chunks.length === 1) return translateOne({ text: chunks[0], sourceLang, targetLang });
  const out = [];
  for (const c of chunks) {
    out.push(await translateOne({ text: c, sourceLang, targetLang }));
  }
  return out.join(' ');
}

// Bulbul v3 caps each `inputs[]` string at 500 chars. Split long translations
// on sentence boundaries so a single long utterance doesn't fail the whole call.
const MAX_TTS_CHARS = 450;

function chunkText(text, maxLen = MAX_TTS_CHARS) {
  const trimmed = (text || '').trim();
  if (trimmed.length <= maxLen) return [trimmed];
  // Split on sentence enders including Devanagari danda + CJK full stop.
  const parts = trimmed.split(/(?<=[.!?।॥。])\s+/);
  const chunks = [];
  let buf = '';
  for (const p of parts) {
    // Sentence itself is too long — split on commas, then on whitespace.
    if (p.length > maxLen) {
      if (buf) { chunks.push(buf); buf = ''; }
      const sub = p.split(/(?<=[,;:])\s+|\s+/);
      let sb = '';
      for (const w of sub) {
        if ((sb + ' ' + w).trim().length > maxLen) {
          if (sb) chunks.push(sb);
          sb = w;
        } else {
          sb = sb ? sb + ' ' + w : w;
        }
      }
      if (sb) chunks.push(sb);
      continue;
    }
    if ((buf + ' ' + p).trim().length > maxLen) {
      if (buf) chunks.push(buf);
      buf = p;
    } else {
      buf = buf ? buf + ' ' + p : p;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// Returns an array of base64 audio strings — one per chunk. Callers should
// play them sequentially via `playBase64Audio`.
export async function textToSpeech({ text, languageCode, speaker = 'anand' }) {
  const chunks = chunkText(text);
  const audios = [];
  for (const chunk of chunks) {
    const res = await fetch(`${API_BASE}/text-to-speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inputs: [chunk],
        target_language_code: toNonSTTCode(languageCode),
        speaker,
        model: 'bulbul:v3',
        pace: 1.0,
      }),
    });
    if (!res.ok) throw new Error(`Sarvam TTS failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
    const data = await res.json();
    const b64 = data.audios?.[0] ?? data.audio ?? '';
    if (b64) audios.push(b64);
  }
  return audios;
}

// ─── Playback ────────────────────────────────────────────────────────────────
// One AudioContext per target sinkId. Chrome supports two ways to route an
// AudioContext to a non-default output:
//   1. Constructor option: new AudioContext({ sinkId })  — landed Chrome 110
//      but some builds silently ignore it for deviceIds from enumerateDevices.
//   2. Method:  ctx.setSinkId(deviceId)                  — Chrome 110+,
//      consistently honoured. This is the path we rely on.
// We always construct with the default, then call setSinkId if a non-default
// target was requested, and log the outcome so routing failures surface in
// the offscreen devtools console instead of silently going to speakers.
const _ctxBySink = new Map();

async function makeContext(sinkId) {
  const AC = self.AudioContext || self.webkitAudioContext;
  const ctx = new AC();
  if (!sinkId || sinkId === 'default') return ctx;
  try {
    if (typeof ctx.setSinkId === 'function') {
      await ctx.setSinkId(sinkId);
      console.log('[vaaksetu] audio routed to sinkId', sinkId);
    } else {
      console.warn('[vaaksetu] ctx.setSinkId unavailable — audio will play on system default');
    }
  } catch (err) {
    console.warn('[vaaksetu] setSinkId failed for', sinkId, err?.message || err,
      '— audio will play on system default');
  }
  return ctx;
}

export async function getAudioContext(sinkId = 'default') {
  let ctx = _ctxBySink.get(sinkId);
  if (!ctx) {
    ctx = await makeContext(sinkId);
    _ctxBySink.set(sinkId, ctx);
  }
  if (ctx.state === 'suspended') { try { await ctx.resume(); } catch {} }
  return ctx;
}

export async function playBase64Audio(base64Str, { sinkId = 'default' } = {}) {
  const binary = atob(base64Str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const ctx = await getAudioContext(sinkId);
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(0));
  return new Promise((resolve) => {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = resolve;
    src.start(0);
  });
}
