/**
 * sarvam-tts-stream.js — Streaming Bulbul TTS for the webapp.
 *
 * Uses the /api/text-to-speech-stream proxy. Server pipes Sarvam's streamed
 * audio body back to the client; we feed it into a MediaSource SourceBuffer
 * attached to a hidden <audio> element. Playback starts within ~200-500ms
 * of the request rather than waiting for full Bulbul generation (~1-3s).
 *
 * Used only in hands-free / Go Live paths. Push-to-talk keeps batch.
 */

const BASE = import.meta.env.DEV ? '/sarvam' : '/api';
const toNonSTTCode = (c) => (c === 'or-IN' ? 'od-IN' : c);

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
  text, languageCode, speaker = 'anand', sinkId = 'default', apiKey, onFirstAudio, getAuthHeader,
}) {
  const mime = pickMime();
  if (!mime) throw new Error('MediaSource / supported audio MIME unavailable');

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['api-subscription-key'] = apiKey;
  if (getAuthHeader) {
    const token = await getAuthHeader();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}/text-to-speech-stream`, {
    method: 'POST',
    headers,
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
    try { await audio.setSinkId(sinkId); } catch (e) { console.warn('[streaming-tts] setSinkId failed', e?.message); }
  }

  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);

  return new Promise((resolve, reject) => {
    let resolved = false;
    let started = false;
    let sb = null;
    const queue = [];
    let upstreamDone = false;

    const cleanup = () => { try { URL.revokeObjectURL(audio.src); } catch {} };

    audio.addEventListener('ended', () => {
      if (resolved) return; resolved = true; cleanup(); resolve();
    });
    audio.addEventListener('error', () => {
      if (resolved) return; resolved = true; cleanup();
      reject(new Error(`Audio playback error: ${audio.error?.message || 'unknown'}`));
    });

    const pumpQueue = () => {
      if (!sb || sb.updating || queue.length === 0) return;
      const next = queue.shift();
      try { sb.appendBuffer(next); }
      catch (err) { console.warn('[streaming-tts] appendBuffer failed:', err?.message); }
    };

    ms.addEventListener('sourceopen', async () => {
      try {
        sb = ms.addSourceBuffer(mime);
        sb.addEventListener('updateend', () => {
          if (!started && audio.readyState >= 2) {
            started = true;
            audio.play().catch((err) => console.warn('[streaming-tts] play() rejected:', err?.message));
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
