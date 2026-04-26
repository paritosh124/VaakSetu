// Streaming Bulbul TTS client (extension).
// Hits /api/text-to-speech-stream (auth-gated), reads the response body as
// it arrives, and feeds chunks into a MediaSource SourceBuffer attached to a
// new Audio element. Result: playback starts as soon as the first ~50KB of
// audio data is available — typically 200-500ms after the request — instead
// of waiting for full generation.
//
// Returns a promise that resolves when playback finishes. `onFirstAudio` is
// called the moment we begin playback (use it to mark first-audio latency).
import { API_BASE } from '../config.js';
import { authedFetch } from '../auth.js';

const toNonSTTCode = (c) => (c === 'or-IN' ? 'od-IN' : c);

// MIME types to try in order. Sarvam currently returns MP3 for streaming;
// we fall through to the others if SourceBuffer rejects the first.
const CANDIDATE_MIMES = ['audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"', 'audio/aac'];

function pickMime() {
  if (typeof MediaSource === 'undefined') return null;
  for (const m of CANDIDATE_MIMES) {
    try { if (MediaSource.isTypeSupported(m)) return m; } catch {}
  }
  return null;
}

export function streamingTTSSupported() {
  return typeof MediaSource !== 'undefined' && pickMime() !== null;
}

export async function streamingTextToSpeech({
  text, languageCode, speaker = 'anand', sinkId = 'default', onFirstAudio,
}) {
  const mime = pickMime();
  if (!mime) throw new Error('MediaSource / supported audio MIME unavailable');

  const res = await authedFetch(`${API_BASE}/text-to-speech-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      target_language_code: toNonSTTCode(languageCode),
      speaker,
      model: 'bulbul:v3',
      pace: 1.0,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Streaming TTS failed (${res.status}): ${body || res.statusText}`);
  }

  const audio = new Audio();
  audio.preload = 'auto';
  if (sinkId && sinkId !== 'default' && typeof audio.setSinkId === 'function') {
    try { await audio.setSinkId(sinkId); } catch (e) {
      console.warn('[vaaksetu streaming-tts] setSinkId failed:', e?.message);
    }
  }

  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let started = false;
    let sb = null;
    const queue = [];
    let upstreamDone = false;

    const cleanup = () => {
      try { URL.revokeObjectURL(audio.src); } catch {}
    };

    audio.addEventListener('ended', () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve();
    });
    audio.addEventListener('error', (e) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new Error(`Audio playback error: ${audio.error?.message || 'unknown'}`));
    });

    const pumpQueue = () => {
      if (!sb || sb.updating || queue.length === 0) return;
      const next = queue.shift();
      try { sb.appendBuffer(next); }
      catch (err) { console.warn('[vaaksetu streaming-tts] appendBuffer failed:', err?.message); }
    };

    ms.addEventListener('sourceopen', async () => {
      try {
        sb = ms.addSourceBuffer(mime);
        sb.addEventListener('updateend', () => {
          // Once we have data, kick off playback.
          if (!started && audio.readyState >= 2) {
            started = true;
            audio.play().catch((err) => console.warn('[vaaksetu streaming-tts] play() rejected:', err?.message));
            onFirstAudio?.();
          }
          pumpQueue();
          if (upstreamDone && queue.length === 0 && !sb.updating && ms.readyState === 'open') {
            try { ms.endOfStream(); } catch {}
          }
        });

        const reader = res.body.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) { upstreamDone = true; pumpQueue(); break; }
          queue.push(value);
          pumpQueue();
        }
      } catch (err) {
        if (!resolved) { resolved = true; reject(err); }
      }
    }, { once: true });
  });
}
