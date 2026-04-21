/**
 * openai.js — Whisper (STT) + GPT-4o-mini (translate) + TTS-1 (speech)
 * Used for international (non-Indian) language pairs.
 *
 * In dev, Vite proxies /openai → https://api.openai.com
 * In prod, serverless functions at /api/openai-* inject OPENAI_API_KEY
 */

const BASE = import.meta.env.DEV ? '/openai' : '/api';

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ─── Speech → English (Whisper translations endpoint) ────────────────────────
export async function openaiSpeechToText({ audioBlob, apiKey }) {
  const fd = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
  fd.append('file', audioBlob, `audio.${ext}`);
  fd.append('model', 'whisper-1');
  fd.append('response_format', 'json');

  const res = await fetch(`${BASE}/openai-stt`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: fd,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`STT failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  return data.text?.trim() || '';
}

// Same endpoint but uses /translations to always return English
export async function openaiSpeechToEnglish({ audioBlob, apiKey }) {
  const fd = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : audioBlob.type.includes('ogg') ? 'ogg' : 'webm';
  fd.append('file', audioBlob, `audio.${ext}`);
  fd.append('model', 'whisper-1');
  fd.append('response_format', 'json');

  const res = await fetch(`${BASE}/openai-stt-translate`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
    body: fd,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`STT failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  return data.text?.trim() || '';
}

// ─── Translate text via GPT-4o-mini ──────────────────────────────────────────
export async function openaiTranslate({ text, targetLangName, apiKey }) {
  const res = await fetch(`${BASE}/openai-chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a translator. Translate the input text to ${targetLangName}. Output only the translated text with no explanation.`,
        },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Translate failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Text → Speech (TTS-1) → base64 mp3 ─────────────────────────────────────
// Returns base64 string compatible with playBase64Audio in sarvam.js
export async function openaiTTS({ text, voice = 'onyx', apiKey }) {
  const res = await fetch(`${BASE}/openai-tts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TTS failed (${res.status}): ${body || res.statusText}`);
  }

  const ab = await res.arrayBuffer();
  return arrayBufferToBase64(ab);
}
