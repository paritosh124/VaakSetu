/**
 * pipeline.js — Orchestrates the 3-step translation pipeline
 *
 * Optimised flow:
 *   Indian lang → Saaras (mode=translate) → English → Mayura → target  [3 calls]
 *   English     → Saaras (mode=transcribe) → Mayura → target            [3 calls]
 *   Any → English  skips Mayura entirely                                 [2 calls]
 */

import { speechToText, translateText, textToSpeech, playBase64Audio } from './api/sarvam.js';
import { streamingTextToSpeech, streamingTTSSupported } from './api/sarvam-tts-stream.js';
import { openaiSpeechToEnglish, openaiTranslate, openaiTTS } from './api/openai.js';
import { groqSpeechToEnglish, groqTranslate, browserTTS } from './api/groq.js';
import { googleTTS } from './api/google-tts.js';

/**
 * Sender half — used in remote (two-phone) mode.
 * Speech → English pivot text only. Result is sent to partner over WebRTC.
 */
export async function speechToEnglish({ audioBlob, sourceLang, apiKey, onStep }) {
  const isSourceEnglish = sourceLang === 'en-IN';
  const mode = isSourceEnglish ? 'transcribe' : 'translate';
  onStep?.('stt', isSourceEnglish ? 'Transcribing…' : 'Converting speech to English…');
  const sttResult = await speechToText({ audioBlob, languageCode: sourceLang, mode, apiKey });
  return sttResult.transcript;
}

/**
 * Receiver half — used in remote (two-phone) mode.
 * English pivot text → TTS in my language with my voice.
 */
export async function englishToSpeech({ pivotText, targetLang, voice, apiKey, onStep, onText, streamTTS = false }) {
  const isTargetEnglish = targetLang === 'en-IN';
  let translatedText = pivotText;

  if (!isTargetEnglish) {
    onStep?.('translate', `Translating to ${targetLang.split('-')[0].toUpperCase()}…`);
    translatedText = await translateText({ text: pivotText, sourceLang: 'en-IN', targetLang, apiKey });
  }

  onText?.(pivotText, translatedText);

  onStep?.('tts', 'Generating voice…');

  // Streaming Bulbul: ~200-500ms to first audio vs ~1-3s for batch.
  // Used in Go Live / hands-free; PTT keeps the simpler batch path.
  if (streamTTS && streamingTTSSupported()) {
    try {
      onStep?.('playing', 'Playing…');
      const audioPromise = streamingTextToSpeech({
        text: translatedText,
        languageCode: targetLang,
        speaker: voice || 'anand',
        apiKey,
      }).then(() => onStep?.('done', ''));
      return { pivotText, translatedText, audioB64: [], audioPromise };
    } catch (err) {
      console.warn('[pipeline] streaming TTS failed, falling back to batch:', err?.message);
    }
  }

  const audioB64 = await textToSpeech({ text: translatedText, languageCode: targetLang, speaker: voice || 'anand', apiKey });

  onStep?.('playing', 'Playing…');
  const audioPromise = playBase64Audio(audioB64).then(() => onStep?.('done', ''));

  return { pivotText, translatedText, audioB64, audioPromise };
}

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

// ─── OpenAI pipeline (international languages) ───────────────────────────────

/**
 * Full OpenAI pipeline: Whisper STT → GPT translate → TTS-1
 * sourceLang / targetLang are 2-letter ISO codes (e.g. 'es', 'ja')
 * OR 'en-IN' for English (handled correctly — skips translate step if target is English)
 */
export async function runOpenAIPipeline({
  audioBlob,
  sourceLang,
  sourceLangName,
  targetLang,
  targetLangName,
  voiceGender,
  openaiKey,
  onStep,
  onText,
}) {
  const isTargetEnglish = targetLang === 'en-IN' || targetLang === 'en';

  // Step 1: Whisper → English pivot
  onStep('stt', 'Transcribing speech…');
  const pivotText = await openaiSpeechToEnglish({ audioBlob, apiKey: openaiKey });

  // Step 2: GPT translate (skip if target is English)
  let translatedText = pivotText;
  if (!isTargetEnglish) {
    onStep('translate', `Translating to ${targetLangName}…`);
    translatedText = await openaiTranslate({ text: pivotText, targetLangName, apiKey: openaiKey });
  }

  onText?.(pivotText, translatedText);

  // Step 3: TTS-1
  onStep('tts', 'Generating voice…');
  const voice = voiceGender === 'female' ? 'nova' : 'onyx';
  const audioB64 = await openaiTTS({ text: translatedText, voice, apiKey: openaiKey });

  onStep('playing', 'Playing…');
  const audioPromise = playBase64Audio(audioB64).then(() => onStep('done', ''));

  return { pivotText, translatedText, audioB64, audioPromise };
}

/**
 * Sender half for remote mode — Whisper → English pivot only.
 * Works for any language (including Indian).
 */
export async function openaiSpeechToEnglishPipeline({ audioBlob, openaiKey, onStep }) {
  onStep?.('stt', 'Transcribing speech…');
  return openaiSpeechToEnglish({ audioBlob, apiKey: openaiKey });
}

/**
 * Receiver half for remote mode — English → TTS in target international language.
 */
export async function openaiEnglishToSpeech({
  pivotText,
  targetLang,
  targetLangName,
  voiceGender,
  openaiKey,
  onStep,
  onText,
}) {
  const isTargetEnglish = targetLang === 'en-IN' || targetLang === 'en';
  let translatedText = pivotText;

  if (!isTargetEnglish) {
    onStep?.('translate', `Translating to ${targetLangName}…`);
    translatedText = await openaiTranslate({ text: pivotText, targetLangName, apiKey: openaiKey });
  }

  onText?.(pivotText, translatedText);

  onStep?.('tts', 'Generating voice…');
  const voice = voiceGender === 'female' ? 'nova' : 'onyx';
  const audioB64 = await openaiTTS({ text: translatedText, voice, apiKey: openaiKey });

  onStep?.('playing', 'Playing…');
  const audioPromise = playBase64Audio(audioB64).then(() => onStep?.('done', ''));

  return { pivotText, translatedText, audioB64, audioPromise };
}

// ─── Groq + Google TTS pipeline (international languages) ────────────────────

/**
 * Full Groq+Google TTS pipeline: Groq Whisper STT → Llama translate → Google Cloud TTS
 * Same interface as runOpenAIPipeline — drop-in replacement.
 */
export async function runGroqPipeline({
  audioBlob,
  sourceLang,
  targetLang,
  targetLangName,
  voiceGender,
  groqKey,
  openaiKey,
  onStep,
  onText,
}) {
  const isTargetEnglish = targetLang === 'en-IN' || targetLang === 'en';

  onStep('stt', 'Transcribing speech…');
  const pivotText = await groqSpeechToEnglish({ audioBlob, apiKey: groqKey, sourceLang });

  let translatedText = pivotText;
  if (!isTargetEnglish) {
    onStep('translate', `Translating to ${targetLangName}…`);
    translatedText = await groqTranslate({ text: pivotText, targetLangName, apiKey: groqKey });
  }

  onText?.(pivotText, translatedText);

  onStep('tts', 'Generating voice…');

  try {
    const audioB64 = await googleTTS({ text: translatedText, languageCode: targetLang, voiceGender });
    onStep('playing', 'Playing…');
    const audioPromise = playBase64Audio(audioB64).then(() => onStep('done', ''));
    return { pivotText, translatedText, audioB64, audioPromise };
  } catch {
    // Fallback to browser TTS if Google TTS fails (e.g. no API key in dev)
    onStep('playing', 'Playing…');
    const audioPromise = browserTTS({ text: translatedText, languageCode: targetLang, voiceGender })
      .then(() => onStep('done', ''))
      .catch(() => onStep('done', ''));
    return { pivotText, translatedText, audioB64: null, audioPromise };
  }
}

/**
 * Sender half for remote mode — Groq Whisper → English pivot only.
 */
export async function groqSpeechToEnglishPipeline({ audioBlob, groqKey, sourceLang, onStep }) {
  onStep?.('stt', 'Transcribing speech…');
  return groqSpeechToEnglish({ audioBlob, apiKey: groqKey, sourceLang });
}

/**
 * Receiver half for remote mode — Groq translate → Google Cloud TTS.
 */
export async function groqEnglishToSpeech({
  pivotText,
  targetLang,
  targetLangName,
  voiceGender,
  groqKey,
  openaiKey,
  onStep,
  onText,
}) {
  const isTargetEnglish = targetLang === 'en-IN' || targetLang === 'en';
  let translatedText = pivotText;

  if (!isTargetEnglish) {
    onStep?.('translate', `Translating to ${targetLangName}…`);
    translatedText = await groqTranslate({ text: pivotText, targetLangName, apiKey: groqKey });
  }

  onText?.(pivotText, translatedText);

  onStep?.('tts', 'Generating voice…');

  try {
    const audioB64 = await googleTTS({ text: translatedText, languageCode: targetLang, voiceGender });
    onStep?.('playing', 'Playing…');
    const audioPromise = playBase64Audio(audioB64).then(() => onStep?.('done', ''));
    return { pivotText, translatedText, audioB64, audioPromise };
  } catch {
    onStep?.('playing', 'Playing…');
    const audioPromise = browserTTS({ text: translatedText, languageCode: targetLang, voiceGender })
      .then(() => onStep?.('done', ''))
      .catch(() => onStep?.('done', ''));
    return { pivotText, translatedText, audioB64: null, audioPromise };
  }
}
