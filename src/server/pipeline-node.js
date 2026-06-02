// pipeline-node.js — Node port of the translation pipeline data transforms.
//
// This is NOT a copy of src/pipeline.js. The browser pipeline uses
// import.meta.env, AudioContext, MediaRecorder and the relative /api/* proxy
// paths — none of which exist in Node. Here we call the upstream provider APIs
// (Sarvam, Groq, Google) DIRECTLY with server-side keys, and only deal in
// text + bytes. Audio is returned as base64 and relayed to the browser, which
// decodes/plays it. No Web Audio API is touched here.
//
// Engine routing mirrors CLAUDE.md's hybrid model:
//   STT (→ English): Indian source → Saaras (translate mode); intl → Groq Whisper+Llama
//   Translate (English → target): Indian → Mayura; intl → Groq Llama 70B
//   TTS (text → audio): Indian → Bulbul; intl → Google Cloud TTS

import {
  SARVAM_API_KEY, GROQ_API_KEY, GOOGLE_TTS_API_KEY,
  SAMPLE_RATE, isIndianLang, SARVAM_VOICES,
} from './config.js';

// Sarvam uses 'or-IN' for Odia STT but 'od-IN' for Translate/TTS.
const toSTTCode    = (c) => (c === 'od-IN' ? 'or-IN' : c);
const toNonSTTCode = (c) => (c === 'or-IN' ? 'od-IN' : c);

// Human-readable names for the Groq Llama translation prompt.
const INTL_NAMES = {
  es: 'Spanish', fr: 'French', de: 'German', ja: 'Japanese', zh: 'Chinese',
  ar: 'Arabic', pt: 'Portuguese', ru: 'Russian', it: 'Italian', ko: 'Korean',
  nl: 'Dutch', tr: 'Turkish', pl: 'Polish', sv: 'Swedish', th: 'Thai',
  vi: 'Vietnamese', id: 'Indonesian', uk: 'Ukrainian', en: 'English', 'en-IN': 'English',
};
const langName = (code) => INTL_NAMES[code] || INTL_NAMES[code?.split('-')[0]] || code;

// ─── PCM → WAV ────────────────────────────────────────────────────────────────
// Recall delivers raw PCM; Sarvam/Groq batch STT want an audio file. Wrap the
// 16 kHz mono 16-bit PCM buffer in a minimal WAV container.
export function pcmToWav(pcmBuffer, sampleRate = SAMPLE_RATE) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// ─── STT → English pivot ────────────────────────────────────────────────────
// `audio` is { buffer: Buffer, mime: string }. For PCM from Recall, pass a WAV
// (via pcmToWav) with mime 'audio/wav'. For a browser blob, pass its bytes+mime.
export async function sttToEnglish({ audio, sourceLang }) {
  if (isIndianLang(sourceLang)) {
    // Saaras: 'translate' emits English directly; 'transcribe' for en-IN source.
    const mode = sourceLang === 'en-IN' ? 'transcribe' : 'translate';
    return sarvamSTT({ audio, languageCode: sourceLang, mode });
  }
  // Intl source → Groq Whisper transcribe, then Llama → English (if not already).
  const transcript = await groqTranscribe({ audio, sourceLang });
  if (!transcript) return '';
  if (sourceLang === 'en' || sourceLang === 'en-IN') return transcript;
  return groqTranslate({ text: transcript, targetLangName: 'English' });
}

async function sarvamSTT({ audio, languageCode, mode }) {
  const fd = new FormData();
  const ext = audio.mime.includes('wav') ? 'wav' : audio.mime.includes('mp4') ? 'm4a' : 'webm';
  fd.append('file', new Blob([audio.buffer], { type: audio.mime }), `audio.${ext}`);
  fd.append('model', 'saaras:v3');
  fd.append('mode', mode);
  fd.append('language_code', toSTTCode(languageCode));

  const res = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_API_KEY },
    body: fd,
  });
  if (!res.ok) throw new Error(`Sarvam STT ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.transcript || '';
}

async function groqTranscribe({ audio, sourceLang }) {
  const fd = new FormData();
  const ext = audio.mime.includes('wav') ? 'wav' : audio.mime.includes('mp4') ? 'm4a' : 'webm';
  fd.append('file', new Blob([audio.buffer], { type: audio.mime }), `audio.${ext}`);
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'json');
  if (sourceLang) fd.append('language', sourceLang.split('-')[0]); // ISO-639-1

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`Groq STT ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.text || '';
}

// ─── Translate (English pivot → target) ──────────────────────────────────────
export async function translateFromEnglish({ text, targetLang }) {
  if (!text) return '';
  if (targetLang === 'en-IN' || targetLang === 'en') return text; // already English
  if (isIndianLang(targetLang)) {
    return mayuraTranslate({ text, sourceLang: 'en-IN', targetLang });
  }
  return groqTranslate({ text, targetLangName: langName(targetLang) });
}

async function mayuraTranslate({ text, sourceLang, targetLang }) {
  const res = await fetch('https://api.sarvam.ai/translate', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      input: text,
      source_language_code: toNonSTTCode(sourceLang),
      target_language_code: toNonSTTCode(targetLang),
      model: 'mayura:v1',
      mode: 'formal', // strict translation — see CLAUDE.md (modern-colloquial leaks English words)
    }),
  });
  if (!res.ok) throw new Error(`Mayura ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.translated_text ?? data.translation ?? data.output ?? '';
}

async function groqTranslate({ text, targetLangName }) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `You are a translation engine. The user will send text inside <translate> tags. Translate that text to ${targetLangName}. Output ONLY the translated text — no tags, no explanation, no extra content.`,
        },
        { role: 'user', content: `<translate>${text}</translate>` },
      ],
      temperature: 0.0,
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`Groq translate ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── TTS (text → audio) ───────────────────────────────────────────────────────
// Returns { b64, format }. Bulbul → WAV. Google → MP3 by default, or WAV
// (LINEAR16) when `pcm16` is set. The LiveKit inject path needs WAV/PCM, so the
// agent→customer direction passes pcm16:true to keep both engines WAV-parseable.
export async function tts({ text, targetLang, voiceGender = 'male', pcm16 = false }) {
  if (!text) return { b64: '', format: 'wav' };
  if (isIndianLang(targetLang)) {
    const b64 = await bulbulTTS({ text, languageCode: targetLang, voiceGender });
    return { b64, format: 'wav' };
  }
  const b64 = await googleTTS({ text, languageCode: targetLang, voiceGender, pcm16 });
  return { b64, format: pcm16 ? 'wav' : 'mp3' };
}

async function bulbulTTS({ text, languageCode, voiceGender }) {
  const res = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: { 'api-subscription-key': SARVAM_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: toNonSTTCode(languageCode),
      speaker: SARVAM_VOICES[voiceGender] || SARVAM_VOICES.male,
      model: 'bulbul:v3',
      pace: 1.0,
    }),
  });
  if (!res.ok) throw new Error(`Bulbul ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.audios?.[0] ?? data.audio ?? '';
}

const GOOGLE_LANG_MAP = {
  es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP', zh: 'zh-CN', ar: 'ar-XA',
  pt: 'pt-BR', ru: 'ru-RU', it: 'it-IT', ko: 'ko-KR', nl: 'nl-NL', tr: 'tr-TR',
  pl: 'pl-PL', sv: 'sv-SE', th: 'th-TH', vi: 'vi-VN', id: 'id-ID', uk: 'uk-UA',
  en: 'en-US', 'en-IN': 'en-IN',
};
async function googleTTS({ text, languageCode, voiceGender, pcm16 = false }) {
  const gcpLang = GOOGLE_LANG_MAP[languageCode] || GOOGLE_LANG_MAP[languageCode?.split('-')[0]] || 'en-US';
  // LINEAR16 returns a WAV (PCM) container — needed for LiveKit injection.
  const audioConfig = pcm16
    ? { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 }
    : { audioEncoding: 'MP3' };
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: gcpLang, ssmlGender: voiceGender === 'female' ? 'FEMALE' : 'MALE' },
        audioConfig,
      }),
    },
  );
  if (!res.ok) throw new Error(`Google TTS ${res.status}: ${await res.text().catch(() => '')}`);
  const data = await res.json();
  return data.audioContent || '';
}

// ─── Full turns ───────────────────────────────────────────────────────────────
// Customer spoke → the agent should hear it in their language.
//   audio: { buffer, mime }  (WAV-wrapped PCM from Recall, or a browser blob)
export async function customerTurn({ audio, customerLang, agentLang, agentVoice }) {
  const pivotEn = await sttToEnglish({ audio, sourceLang: customerLang });
  if (!pivotEn) return null;
  const agentText = await translateFromEnglish({ text: pivotEn, targetLang: agentLang });
  const { b64, format } = await tts({ text: agentText, targetLang: agentLang, voiceGender: agentVoice });
  return { pivotEn, text: agentText, audioB64: b64, audioFormat: format };
}

// Agent spoke → the customer should hear it in their language (inject into Meet).
export async function agentTurn({ audio, agentLang, customerLang, customerVoice }) {
  const pivotEn = await sttToEnglish({ audio, sourceLang: agentLang });
  if (!pivotEn) return null;
  const customerText = await translateFromEnglish({ text: pivotEn, targetLang: customerLang });
  // pcm16:true → WAV from both engines so the relay can parse + inject into LiveKit.
  const { b64, format } = await tts({ text: customerText, targetLang: customerLang, voiceGender: customerVoice, pcm16: true });
  return { pivotEn, text: customerText, audioB64: b64, audioFormat: format };
}
