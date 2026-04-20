/**
 * pipeline.js — Orchestrates the 3-step translation pipeline
 *
 * Optimised flow:
 *   Indian lang → Saaras (mode=translate) → English → Mayura → target  [3 calls]
 *   English     → Saaras (mode=transcribe) → Mayura → target            [3 calls]
 *   Any → English  skips Mayura entirely                                 [2 calls]
 */

import { speechToText, translateText, textToSpeech, playBase64Audio } from './api/sarvam.js';

/**
 * @param {Object} opts
 * @param {Blob}     opts.audioBlob    - Recorded audio
 * @param {string}   opts.sourceLang   - BCP-47 code of speaker's language
 * @param {string}   opts.targetLang   - BCP-47 code of listener's language
 * @param {string}   opts.voice        - Bulbul v3 speaker name (e.g. 'anand', 'ritu')
 * @param {string}   opts.apiKey
 * @param {Function} opts.onStep       - (stepId, message) => void  for UI updates
 * @param {Function} opts.onText       - (pivotText, translatedText) => void  emitted as soon as text is ready
 * @returns {{ pivotText, translatedText, audioB64, audioPromise, detectedLang }}
 */
export async function runTranslatePipeline({ audioBlob, sourceLang, targetLang, voice, apiKey, onStep, onText }) {
  const isSourceEnglish = sourceLang === 'en-IN';
  const isTargetEnglish = targetLang === 'en-IN';

  // ── Step 1: Speech → Text (+ translation to English if source is not English) ──
  const sttMode = isSourceEnglish ? 'transcribe' : 'translate';
  onStep('stt', isSourceEnglish ? 'Transcribing speech…' : 'Recognising & converting to English…');

  const sttResult = await speechToText({
    audioBlob,
    languageCode: sourceLang,
    mode: sttMode,
    apiKey,
  });

  const pivotText = sttResult.transcript;

  // ── Step 2: Translate English → target language (skip if target IS English) ──
  let translatedText = pivotText;

  if (!isTargetEnglish) {
    onStep('translate', `Translating to ${targetLang.split('-')[0].toUpperCase()}…`);
    translatedText = await translateText({
      text: pivotText,
      sourceLang: 'en-IN',
      targetLang,
      apiKey,
    });
  }

  // ── Text is ready — notify UI immediately so it can render before audio ──
  onText?.(pivotText, translatedText);

  // ── Step 3: Text → Speech ────────────────────────────────────────────────
  onStep('tts', 'Generating voice…');
  const audioB64 = await textToSpeech({
    text: translatedText,
    languageCode: targetLang,
    speaker: voice || 'anand',
    apiKey,
  });

  // ── Step 4: Play (don't await — let caller handle in background) ─────────
  onStep('playing', 'Playing…');
  const audioPromise = playBase64Audio(audioB64).then(() => onStep('done', ''));

  return {
    pivotText,
    translatedText,
    audioB64,
    audioPromise,
    detectedLang: sttResult.detectedLanguage,
  };
}
