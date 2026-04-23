// pipeline.js — Extension pipeline orchestrator.
// One entrypoint: translateAudio({ audioBlob, sourceLang, targetLang, voiceGender, onStep, onText })
// Returns { pivotText, translatedText, audioPromise } where audioPromise resolves when TTS finishes playing.
//
// Routing:
//   both Indian        → Sarvam (Saaras translate → Mayura → Bulbul)
//   either intl        → Groq (Whisper + Llama) → ElevenLabs TTS
//   target is English  → skip translate step
import { speechToText, translateText, textToSpeech, playBase64Audio } from './api/sarvam.js';
import { groqSpeechToEnglish, groqTranslate } from './api/groq.js';
import { elevenLabsTTS } from './api/elevenlabs.js';
import { isIndianLang, getLang } from './config.js';

const SARVAM_VOICE = { male: 'anand', female: 'ritu' };

export async function translateAudio({ audioBlob, sourceLang, targetLang, voiceGender = 'male', onStep, onText }) {
  const step = (id, msg) => onStep?.(id, msg);
  const needsIntl = !isIndianLang(sourceLang) || !isIndianLang(targetLang);

  if (!needsIntl) return sarvamFlow({ audioBlob, sourceLang, targetLang, voiceGender, step, onText });
  return groqFlow({ audioBlob, sourceLang, targetLang, voiceGender, step, onText });
}

async function sarvamFlow({ audioBlob, sourceLang, targetLang, voiceGender, step, onText }) {
  const isSrcEn = sourceLang === 'en-IN';
  const isTgtEn = targetLang === 'en-IN';

  step('stt', isSrcEn ? 'Transcribing…' : 'Recognising & converting to English…');
  const sttResult = await speechToText({
    audioBlob,
    languageCode: sourceLang,
    mode: isSrcEn ? 'transcribe' : 'translate',
  });
  const pivotText = sttResult.transcript;

  let translatedText = pivotText;
  if (!isTgtEn) {
    step('translate', `Translating to ${getLang(targetLang).name}…`);
    translatedText = await translateText({ text: pivotText, sourceLang: 'en-IN', targetLang });
  }
  onText?.(pivotText, translatedText);

  step('tts', 'Generating voice…');
  const audioB64 = await textToSpeech({ text: translatedText, languageCode: targetLang, speaker: SARVAM_VOICE[voiceGender] });

  step('playing', 'Playing…');
  const audioPromise = playBase64Audio(audioB64).then(() => step('done', ''));
  return { pivotText, translatedText, audioPromise };
}

async function groqFlow({ audioBlob, sourceLang, targetLang, voiceGender, step, onText }) {
  const isTgtEn = targetLang === 'en-IN' || targetLang === 'en';
  const targetLangName = getLang(targetLang).name;

  step('stt', 'Transcribing speech…');
  const pivotText = await groqSpeechToEnglish({ audioBlob, sourceLang });

  let translatedText = pivotText;
  if (!isTgtEn) {
    step('translate', `Translating to ${targetLangName}…`);
    translatedText = await groqTranslate({ text: pivotText, targetLangName });
  }
  onText?.(pivotText, translatedText);

  step('tts', 'Generating voice…');
  const audioB64 = await elevenLabsTTS({ text: translatedText, voiceGender });

  step('playing', 'Playing…');
  const audioPromise = playBase64Audio(audioB64).then(() => step('done', ''));
  return { pivotText, translatedText, audioPromise };
}
