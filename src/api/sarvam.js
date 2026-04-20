/**
 * sarvam.js — Clean wrapper around Sarvam AI APIs
 *
 * Models used:
 *   STT:       Saaras v3  (saaras:v3)
 *   Translate: Mayura     (mayura:v1)
 *   TTS:       Bulbul v3  (bulbul:v3)
 *
 * In dev (npm run dev), Vite proxies /sarvam → https://api.sarvam.ai
 * In prod, swap BASE to 'https://api.sarvam.ai' or route through your own proxy.
 */

const BASE = import.meta.env.DEV ? '/sarvam' : '/api';

// ─── Speech to Text ──────────────────────────────────────────────────────────
// mode: 'transcribe' → returns original language text
//       'translate'  → returns English translation directly (skips a Mayura call!)
export async function speechToText({ audioBlob, languageCode, mode = 'transcribe', apiKey }) {
  const fd = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
  fd.append('file', audioBlob, `audio.${ext}`);
  fd.append('model', 'saaras:v3');
  fd.append('mode', mode);
  fd.append('language_code', languageCode); // pass 'unknown' for auto-detect

  const res = await fetch(`${BASE}/speech-to-text`, {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey },
    body: fd,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`STT failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  return {
    transcript: data.transcript,
    detectedLanguage: data.language_code,
    confidence: data.language_probability,
  };
}

// ─── Translate ───────────────────────────────────────────────────────────────
// Mayura only supports English ↔ Indian languages (not Indian ↔ Indian direct).
// We always translate from/to 'en-IN' as the pivot language.
export async function translateText({ text, sourceLang, targetLang, apiKey }) {
  const res = await fetch(`${BASE}/translate`, {
    method: 'POST',
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: text,
      source_language_code: sourceLang,
      target_language_code: targetLang,
      model: 'mayura:v1',
      mode: 'modern-colloquial', // natural conversational translation
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Translate failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  // Response field may be translated_text or translation depending on version
  return data.translated_text ?? data.translation ?? data.output ?? '';
}

// ─── Text to Speech ──────────────────────────────────────────────────────────
export async function textToSpeech({ text, languageCode, speaker = 'Anand', apiKey }) {
  const res = await fetch(`${BASE}/text-to-speech`, {
    method: 'POST',
    headers: {
      'api-subscription-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: languageCode,
      speaker,
      model: 'bulbul:v3',
      pace: 1.0,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  return data.audios?.[0] ?? data.audio ?? '';
}

// ─── Audio Playback ──────────────────────────────────────────────────────────
// iOS Safari blocks audio.play() unless an AudioContext was unlocked during a user gesture.
let _audioCtx = null;

export function unlockAudio() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (_audioCtx.state === 'suspended') _audioCtx.resume();
}

export async function playBase64Audio(base64Str) {
  const binary = atob(base64Str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const ctx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();

  const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

  return new Promise((resolve) => {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.onended = resolve;
    source.start(0);
  });
}
