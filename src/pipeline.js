/**
 * pipeline.js — Orchestrates the 3-step translation pipeline
 *
 * Optimised flow:
 *   Indian lang → Saaras (mode=translate) → English → Mayura → target  [3 calls]
 *   English     → Saaras (mode=transcribe) → Mayura → target            [3 calls]
 *   Any → English  skips Mayura entirely                                 [2 calls]
 */

import { speechToText, translateText, textToSpeech, playBase64Audio } from './api/sarvam.js';

const SPEAKERS = {
  a: 'anand',  // Person A voice
  b: 'ritu',   // Person B voice — distinct so listeners can tell them apart
};

/**
 * @param {Object} opts
 * @param {Blob}     opts.audioBlob    - Recorded audio
 * @param {string}   opts.sourceLang   - BCP-47 code of speaker's language
 * @param {string}   opts.targetLang   - BCP-47 code of listener's language
 * @param {string}   opts.speaker      - 'a' or 'b' (chooses TTS voice)
 * @param {string}   opts.apiKey
 * @param {Function} opts.onStep       - (stepId, message) => void  for UI updates
 * @returns {{ pivotText, translatedText, detectedLang }}
 */
export async function runTranslatePipeline({ audioBlob, sourceLang, targetLang, speaker, apiKey, onStep }) {
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

  const pivotText = sttResult.transcript; // Always English at this point

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

  // ── Step 3: Text → Speech ────────────────────────────────────────────────
  onStep('tts', 'Generating voice…');
  const audioB64 = await textToSpeech({
    text: translatedText,
    languageCode: targetLang,
    speaker: SPEAKERS[speaker] ?? 'Anand',
    apiKey,
  });

  // ── Step 4: Play ─────────────────────────────────────────────────────────
  onStep('playing', 'Playing…');
  await playBase64Audio(audioB64);

  onStep('done', '');

  return {
    pivotText,
    translatedText,
    audioB64,
    detectedLang: sttResult.detectedLanguage,
  };
}
