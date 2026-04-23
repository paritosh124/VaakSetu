// ElevenLabs TTS via Vercel proxy.
import { API_BASE } from '../config.js';

const VOICE_IDS = {
  male:   'onwK4e9ZLuTAKqWW03F9', // Daniel
  female: 'EXAVITQu4vr4xnSDxMaL', // Sarah
};

export async function elevenLabsTTS({ text, voiceGender = 'male' }) {
  const voiceId = VOICE_IDS[voiceGender] || VOICE_IDS.male;
  const res = await fetch(`${API_BASE}/elevenlabs-tts?voiceId=${voiceId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });
  if (!res.ok) throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
