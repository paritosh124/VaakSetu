/**
 * groq.js — Groq API wrappers (OpenAI-compatible endpoints)
 *
 * STT:         whisper-large-v3        — best multilingual accuracy on Groq
 * Translation: llama-3.3-70b-versatile — reliable, no hallucination on translation tasks
 *
 * Note: whisper-large-v3-turbo does NOT support /translations endpoint.
 *       We use /transcriptions (original language text) then translate with Llama.
 */

// Dev: Vite proxy /groq → https://api.groq.com
// Prod: Vercel serverless functions at /api/groq-*
const STT_URL  = import.meta.env.DEV ? '/groq/openai/v1/audio/transcriptions' : '/api/groq-stt-translate';
const CHAT_URL = import.meta.env.DEV ? '/groq/openai/v1/chat/completions'      : '/api/groq-chat';

// Speech → original language text
async function groqTranscribe({ audioBlob, apiKey, sourceLang }) {
  const fd = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
  fd.append('file', audioBlob, `audio.${ext}`);
  fd.append('model', 'whisper-large-v3');        // better multilingual than turbo
  fd.append('response_format', 'json');
  if (sourceLang) fd.append('language', sourceLang.split('-')[0]); // ISO-639-1: 'hi-IN' → 'hi'

  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(STT_URL, { method: 'POST', headers, body: fd });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq STT failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  return data.text || '';
}

// Speech → English pivot: transcribe then translate with Llama
export async function groqSpeechToEnglish({ audioBlob, apiKey, sourceLang }) {
  const transcribed = await groqTranscribe({ audioBlob, apiKey, sourceLang });
  if (!transcribed) return '';
  // If already English, skip the translate call
  if (sourceLang === 'en' || sourceLang === 'en-IN') return transcribed;
  return groqTranslate({ text: transcribed, targetLangName: 'English', apiKey });
}

// Text → target language translation
export async function groqTranslate({ text, targetLangName, apiKey }) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',  // 70B is reliable; 8B hallucinates on translation
      messages: [
        {
          role: 'system',
          content: `You are a translation engine. The user will send text inside <translate> tags. Translate that text to ${targetLangName}. Output ONLY the translated text — no tags, no explanation, no extra content.`,
        },
        { role: 'user', content: `<translate>${text}</translate>` },
      ],
      temperature: 0.0,  // deterministic — translation has one correct answer
      max_tokens: 500,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq translate failed (${res.status}): ${body || res.statusText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

/**
 * Browser-native TTS via Web Speech API — free, no API key.
 * Acceptable for European languages on desktop Chrome.
 * NOT recommended for Japanese, Chinese, Arabic, Korean — use ElevenLabs instead.
 * Does NOT return audio data — replay button is unavailable for these messages.
 */
export function browserTTS({ text, languageCode, voiceGender = 'male' }) {
  return new Promise((resolve, reject) => {
    if (!window.speechSynthesis) {
      reject(new Error('Web Speech API not supported in this browser'));
      return;
    }
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang  = languageCode;
    utterance.rate  = 0.92;
    utterance.pitch = voiceGender === 'female' ? 1.1 : 0.9;

    // Wait for voices to load (async on some browsers) then pick best match
    const speak = () => {
      const voices = window.speechSynthesis.getVoices();
      const match = voices.find((v) => v.lang.startsWith(languageCode));
      if (match) utterance.voice = match;
      utterance.onend   = () => resolve();
      utterance.onerror = (e) => { resolve(); }; // resolve not reject — don't break the flow
      window.speechSynthesis.speak(utterance);
    };

    if (window.speechSynthesis.getVoices().length > 0) {
      speak();
    } else {
      window.speechSynthesis.onvoiceschanged = speak;
    }
  });
}
