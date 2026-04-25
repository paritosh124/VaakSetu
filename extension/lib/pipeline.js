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
//              target intl     → OpenAI TTS-1     (~12× cheaper than ElevenLabs
//                                                  for comparable Spanish quality)
import { speechToText, translateText, textToSpeech, playBase64Audio } from './api/sarvam.js';
import { groqSpeechToEnglish, groqTranslate } from './api/groq.js';
import { openaiTTS } from './api/openai.js';
import { isIndianLang, getLang } from './config.js';

const SARVAM_VOICE = { male: 'anand', female: 'ritu' };

// Aggressive first-chunk split — peels off the first sentence (or clause if
// the first sentence runs long) so its TTS round-trip overlaps with TTS for
// the remainder. For multi-sentence translations the listener hears speech
// ~600-1000ms sooner; for a single short sentence the input is unchanged.
const FIRST_CHUNK_MAX = 90;
const SENTENCE_END_RE = /[.!?।॥。](\s|$)/;
function splitForFastFirstChunk(text) {
  const t = (text || '').trim();
  if (t.length <= FIRST_CHUNK_MAX) return [t];

  // Try a sentence end within the first FIRST_CHUNK_MAX chars.
  const head = t.slice(0, FIRST_CHUNK_MAX + 30);
  const m = head.match(SENTENCE_END_RE);
  if (m && m.index >= 5) {
    const cut = m.index + 1;
    return [t.slice(0, cut).trim(), t.slice(cut).trim()];
  }
  // Fall back to a clause-level cut at the last comma/colon before the limit.
  const window = t.slice(0, FIRST_CHUNK_MAX);
  const cma = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
  if (cma >= 20) return [t.slice(0, cma + 1).trim(), t.slice(cma + 1).trim()];
  return [t]; // no good split — let the TTS handle it as one piece
}

export { playBase64Audio };

// Batch path (push-to-talk): audio blob in, full pipeline.
export async function translateAudio({ audioBlob, sourceLang, targetLang, voiceGender = 'male', sinkId, onStep, onText }) {
  const step = (id, msg) => onStep?.(id, msg);
  const srcIndian = isIndianLang(sourceLang);

  let pivotText;
  if (srcIndian) {
    const isSrcEn = sourceLang === 'en-IN';
    step('stt', isSrcEn ? 'Transcribing…' : 'Recognising & converting to English…');
    const sttResult = await speechToText({
      audioBlob, languageCode: sourceLang,
      mode: isSrcEn ? 'transcribe' : 'translate',
    });
    pivotText = sttResult.transcript;
  } else {
    step('stt', 'Transcribing speech…');
    pivotText = await groqSpeechToEnglish({ audioBlob, sourceLang });
  }

  return pivotToSpeech({ pivotText, sourceLang, targetLang, voiceGender, sinkId, onStep, onText });
}

// Streaming path (Go Live): pivot already produced by Sarvam streaming STT.
export async function pivotToSpeech({ pivotText, sourceLang, targetLang, voiceGender = 'male', sinkId, onStep, onText }) {
  const step = (id, msg) => onStep?.(id, msg);
  const tgtIndian = isIndianLang(targetLang);
  const isTgtEnglish = targetLang === 'en-IN' || targetLang === 'en';
  const targetLangName = getLang(targetLang).name;

  let translatedText = pivotText;
  if (!isTgtEnglish) {
    step('translate', `Translating to ${targetLangName}…`);
    translatedText = tgtIndian
      ? await translateText({ text: pivotText, sourceLang: 'en-IN', targetLang })
      : await groqTranslate({ text: pivotText, targetLangName });
  }
  onText?.(pivotText, translatedText);

  step('tts', 'Generating voice…');
  let firstAudioAt = 0;
  const markFirstAudio = () => {
    if (!firstAudioAt) { firstAudioAt = Date.now(); step('playing', 'Playing…'); }
  };

  const audioPromise = (async () => {
    let playChain = Promise.resolve();
    let totalChunks = 0;
    let totalBytes = 0;
    const playOne = async (b64) => {
      if (!b64) { console.warn('[vaaksetu tts] empty audio chunk — skipping'); return; }
      totalChunks++;
      totalBytes += b64.length;
      console.log(`[vaaksetu tts] playing chunk ${totalChunks}, b64 len=${b64.length}, sinkId=${sinkId || 'default'}`);
      try {
        await playBase64Audio(b64, { sinkId });
      } catch (err) {
        console.error('[vaaksetu tts] playBase64Audio failed:', err?.message, err);
        throw err;
      }
    };
    if (tgtIndian) {
      const queued = [];
      const enqueue = (b64) => {
        markFirstAudio();
        playChain = playChain.then(() => playOne(b64));
        queued.push(playChain);
      };
      await textToSpeech({
        text: translatedText,
        languageCode: targetLang,
        speaker: SARVAM_VOICE[voiceGender],
        onChunk: enqueue,
      });
      await Promise.all(queued);
    } else {
      const pieces = splitForFastFirstChunk(translatedText);
      console.log(`[vaaksetu tts] intl pieces:`, pieces.length, pieces.map((p) => p.length));
      const promises = pieces.map((p) => openaiTTS({ text: p, voiceGender }));
      const queued = [];
      for (const p of promises) {
        const b64Promise = p;
        playChain = playChain.then(async () => {
          const b64 = await b64Promise;
          markFirstAudio();
          await playOne(b64);
        });
        queued.push(playChain);
      }
      await Promise.all(queued);
    }
    console.log(`[vaaksetu tts] done — ${totalChunks} chunk(s), ${totalBytes} total bytes`);
    step('done', '');
  })();
  return { pivotText, translatedText, audioPromise };
}
