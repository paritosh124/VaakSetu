// OpenAI TTS-1 via the Vercel /api/openai-tts proxy.
// Used for international targets in place of ElevenLabs — ~12× cheaper
// ($15/1M chars vs $180/1M chars) with comparable quality on Spanish for
// our use case. Returns base64 mp3, same shape as elevenLabsTTS.
import { API_BASE } from '../config.js';
import { authedFetch } from '../auth.js';

// Maps our generic voice gender to OpenAI TTS voices.
const VOICES = {
  male:   'onyx',
  female: 'nova',
};

export async function openaiTTS({ text, voiceGender = 'male' }) {
  const voice = VOICES[voiceGender] || VOICES.male;
  const res = await authedFetch(`${API_BASE}/openai-tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
