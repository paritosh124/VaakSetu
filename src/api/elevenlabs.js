/**
 * elevenlabs.js — ElevenLabs TTS wrapper
 *
 * Model: eleven_turbo_v2_5  — fastest, cheapest, multilingual (32 languages)
 * Cost:  ~$0.50/1M chars vs OpenAI TTS-1's $15/1M chars (~30x cheaper)
 *
 * Voices used:
 *   Male   → Daniel  (onwK4e9ZLuTAKqWW03F9) — neutral, clear, multilingual
 *   Female → Sarah   (EXAVITQu4vr4xnSDxMaL) — warm, natural, multilingual
 */

import { arrayBufferToBase64 } from './openai.js';
import { authedFetch } from '../lib/authed-fetch.js';

const useApi = !import.meta.env.DEV || import.meta.env.VITE_USE_API === '1';
const doFetch = (url, opts) => (useApi ? authedFetch(url, opts) : fetch(url, opts));

const VOICE_IDS = {
  male:   'onwK4e9ZLuTAKqWW03F9', // Daniel — neutral, multilingual
  female: 'EXAVITQu4vr4xnSDxMaL', // Sarah  — warm, multilingual
};

export async function elevenLabsTTS({ text, voiceGender = 'male', apiKey }) {
  const voiceId = VOICE_IDS[voiceGender] || VOICE_IDS.male;

  // useApi → /api/elevenlabs-tts (auth + logging); else Vite proxy direct.
  const url = useApi
    ? `/api/elevenlabs-tts?voiceId=${voiceId}`
    : `/elevenlabs/v1/text-to-speech/${voiceId}`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['xi-api-key'] = apiKey;

  const res = await doFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${body || res.statusText}`);
  }

  const buffer = await res.arrayBuffer();
  return arrayBufferToBase64(buffer);
}
