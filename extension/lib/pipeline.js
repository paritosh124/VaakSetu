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

// Batch path (push-to-talk): audio blob in, full pipeline.
export async function translateAudio({ audioBlob, sourceLang, targetLang, voiceGender = 'male', sinkId, onStep, onText }) {
  const step = (id, msg) => onStep?.(id, msg);
  const srcIndian = isIndianLang(sourceLang);

  // Step 1: Speech → English pivot.
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

  return pivotToSpeech({ pivotText, sourceLang, targetLang, voiceGender, sinkId, onStep, onText });
}

// Streaming path: pivot already produced by Sarvam streaming STT — skip Step 1.
export async function pivotToSpeech({ pivotText, sourceLang, targetLang, voiceGender = 'male', sinkId, onStep, onText }) {
  const step = (id, msg) => onStep?.(id, msg);
  const tgtIndian = isIndianLang(targetLang);
  const isTgtEnglish = targetLang === 'en-IN' || targetLang === 'en';
  const targetLangName = getLang(targetLang).name;

  // Step 2: English pivot → target text.
  let translatedText = pivotText;
  if (!isTgtEnglish) {
    step('translate', `Translating to ${targetLangName}…`);
    translatedText = tgtIndian
      ? await translateText({ text: pivotText, sourceLang: 'en-IN', targetLang })
      : await groqTranslate({ text: pivotText, targetLangName });
  }
  onText?.(pivotText, translatedText);

  // Step 3: Text → Speech.
  // Indian target: Bulbul is per-chunk and each chunk is ≤ a few hundred
  // chars — we pipeline the requests into the playback queue so chunk 1 plays
  // while chunk 2 is still on the wire. This is the single biggest TTS
  // latency win for long utterances (a 3-chunk turn starts ~2× faster).
  // Intl target: ElevenLabs returns a single mp3 so there's nothing to pipeline.
  step('tts', 'Generating voice…');
  let firstAudioAt = 0;

  const audioPromise = (async () => {
    if (tgtIndian) {
      const playQueue = [];
      let playChain = Promise.resolve();
      const enqueue = (b64) => {
        if (!firstAudioAt) { firstAudioAt = Date.now(); step('playing', 'Playing…'); }
        playChain = playChain.then(() => playBase64Audio(b64, { sinkId }));
        playQueue.push(playChain);
      };
      await textToSpeech({
        text: translatedText,
        languageCode: targetLang,
        speaker: SARVAM_VOICE[voiceGender],
        onChunk: enqueue,
      });
      await Promise.all(playQueue);
    } else {
      const b64 = await elevenLabsTTS({ text: translatedText, voiceGender });
      step('playing', 'Playing…');
      if (b64) await playBase64Audio(b64, { sinkId });
    }
    step('done', '');
  })();
  return { pivotText, translatedText, audioPromise };
}
