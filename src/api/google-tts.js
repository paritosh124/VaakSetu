import { authedFetch } from '../lib/authed-fetch.js';

export async function googleTTS({ text, languageCode, voiceGender = 'male' }) {
  const res = await authedFetch('/api/google-tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, languageCode, voiceGender }),
  });
  if (!res.ok) throw new Error(`Google TTS failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  const data = await res.json();
  return data.audioContent; // base64 mp3
}
