// pipeline.js — Extension pipeline orchestrator.
// One entrypoint: translateAudio({ audioBlob, sourceLang, targetLang, voiceGender, onStep, onText })
// Returns { pivotText, translatedText, audioPromise } where audioPromise resolves when TTS finishes playing.
//
// Hybrid routing — each step picks its engine independently based on source/target:
//   STT:       source Indian   → Sarvam Saaras (translate mode → English pivot)
//              source intl     → Groq Whisper  (→ English pivot via Llama if needed)
//   Translate: target English  → skip
//              target Indian   → Sarvam Mayura
//              target intl     → Groq Llama
//   TTS:       target Indian   → Sarvam Bulbul v3  (native Indic voice quality)
//              target intl     → ElevenLabs Turbo v2.5
//
// Why hybrid: ElevenLabs sounds unnatural for Indic output and Bulbul can't
// speak European languages. Letting each step pick its best engine keeps
// intl→Indian pairs (the common call-center case) using Sarvam voices.
import { speechToText, translateText, textToSpeech, playBase64Audio } from './api/sarvam.js';
import { groqSpeechToEnglish, groqTranslate } from './api/groq.js';
import { elevenLabsTTS } from './api/elevenlabs.js';
import { isIndianLang, getLang } from './config.js';

const SARVAM_VOICE = { male: 'anand', female: 'ritu' };

export async function translateAudio({ audioBlob, sourceLang, targetLang, voiceGender = 'male', onStep, onText }) {
  const step = (id, msg) => onStep?.(id, msg);
  const srcIndian = isIndianLang(sourceLang);
  const tgtIndian = isIndianLang(targetLang);
  const isTgtEnglish = targetLang === 'en-IN' || targetLang === 'en';
  const targetLangName = getLang(targetLang).name;

  // ── Step 1: Speech → English pivot ────────────────────────────────────────
  let pivotText;
  if (srcIndian) {
    const isSrcEn = sourceLang === 'en-IN';
    step('stt', isSrcEn ? 'Transcribing…' : 'Recognising & converting to English…');
    const sttResult = await speechToText({
      audioBlob,
      languageCode: sourceLang,
      mode: isSrcEn ? 'transcribe' : 'translate',
    });
    pivotText = sttResult.transcript;
  } else {
    step('stt', 'Transcribing speech…');
    pivotText = await groqSpeechToEnglish({ audioBlob, sourceLang });
  }

  // ── Step 2: English pivot → target text ───────────────────────────────────
  let translatedText = pivotText;
  if (!isTgtEnglish) {
    step('translate', `Translating to ${targetLangName}…`);
    translatedText = tgtIndian
      ? await translateText({ text: pivotText, sourceLang: 'en-IN', targetLang })
      : await groqTranslate({ text: pivotText, targetLangName });
  }
  onText?.(pivotText, translatedText);

  // ── Step 3: Text → Speech ─────────────────────────────────────────────────
  // Sarvam returns an array of base64 chunks (to sidestep Bulbul's 500-char
  // limit); ElevenLabs returns a single base64 string. Normalise to an array.
  step('tts', 'Generating voice…');
  const audios = tgtIndian
    ? await textToSpeech({ text: translatedText, languageCode: targetLang, speaker: SARVAM_VOICE[voiceGender] })
    : [await elevenLabsTTS({ text: translatedText, voiceGender })];

  step('playing', 'Playing…');
  const audioPromise = (async () => {
    for (const b64 of audios) {
      if (b64) await playBase64Audio(b64);
    }
    step('done', '');
  })();
  return { pivotText, translatedText, audioPromise };
}
