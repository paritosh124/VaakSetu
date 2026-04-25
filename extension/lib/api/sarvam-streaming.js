// Sarvam streaming STT for the extension. Ported from src/api/sarvam-streaming.js.
// Key differences vs webapp:
//   - No Vite env — key is fetched once from /api/sarvam-ws-key and cached.
//   - AudioContext is created from the passed-in MediaStream source (tab or mic).
//   - Runs inside the offscreen document, which behaves like a normal page.
import { API_BASE } from '../config.js';
import { authedFetch } from '../auth.js';

const WORKLET_SRC = `
class PCMProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const out = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      out[i] = Math.max(-32768, Math.min(32767, ch[i] * 32767));
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor('vs-pcm-processor', PCMProcessor);
`;

const WS_URL = 'wss://api.sarvam.ai/speech-to-text/streaming';

let _cachedKey = null;
async function getKey() {
  if (_cachedKey) return _cachedKey;
  const res = await authedFetch(`${API_BASE}/sarvam-ws-key`);
  if (!res.ok) throw new Error(`Streaming STT key fetch failed (${res.status})`);
  const data = await res.json();
  _cachedKey = data.key || '';
  return _cachedKey;
}

export function supportsStreamingSTT() {
  return typeof AudioWorkletNode !== 'undefined' && typeof WebSocket !== 'undefined';
}

export class SarvamStreamingSTT {
  constructor({ languageCode, mode = 'translate', onPartial }) {
    this.languageCode = languageCode;
    this.mode = mode;
    this.onPartial = onPartial;
    this._ws = null;
    this._audioCtx = null;
    this._workletNode = null;
    this._sourceNode = null;
    this._lastPartial = '';
    this._stopped = false;
    this._finalPromise = new Promise((res, rej) => {
      this._finalResolve = res;
      this._finalReject = rej;
    });
  }

  async start(mediaStream) {
    const apiKey = await getKey();
    if (!apiKey) throw new Error('No Sarvam key available for streaming');

    const url = `${WS_URL}?api-subscription-key=${apiKey}`;
    console.log('[vaaksetu streaming] opening WS; key prefix:', (apiKey || '').slice(0, 6), 'len:', (apiKey || '').length);
    const ws = new WebSocket(url);
    this._ws = ws;
    ws.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connection timed out after 6s')), 6000);
      ws.onopen = () => {
        clearTimeout(t);
        console.log('[vaaksetu streaming] WS open');
        resolve();
      };
      ws.onerror = (ev) => {
        clearTimeout(t);
        console.error('[vaaksetu streaming] WS error event', ev);
        reject(new Error('WebSocket handshake failed — check Network tab for the 101/4xx status'));
      };
      ws.onclose = (ev) => {
        // Only reject if we never opened (close fires without open).
        if (ws.readyState !== WebSocket.OPEN && !this._stopped) {
          clearTimeout(t);
          console.error(`[vaaksetu streaming] WS closed before open code=${ev.code} reason=${ev.reason || '(none)'}`);
          reject(new Error(`WebSocket closed before open: code=${ev.code} reason="${ev.reason || ''}"`));
        }
      };
    });

    const sttCode = this.languageCode === 'od-IN' ? 'or-IN' : this.languageCode;
    ws.send(JSON.stringify({
      model: 'saaras:v3',
      mode: this.mode,
      language_code: sttCode,
    }));

    ws.onmessage = (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch { return; }
      const text = (data.transcript || data.text || '').trim();
      if (!text) return;
      const isFinal = data.is_final === true || data.type === 'final' || data.final === true;
      if (isFinal) {
        this._finalResolve(text);
      } else {
        this._lastPartial = text;
        this.onPartial?.(text);
      }
    };

    ws.onclose = () => {
      if (!this._stopped) return;
      this._finalResolve(this._lastPartial);
    };
    ws.onerror = () => {
      this._finalReject(new Error('WebSocket error during streaming'));
    };

    // AudioWorklet at 16 kHz — browser resamples from native.
    const AC = self.AudioContext || self.webkitAudioContext;
    this._audioCtx = new AC({ sampleRate: 16000 });
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this._audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this._workletNode = new AudioWorkletNode(this._audioCtx, 'vs-pcm-processor');
    this._workletNode.port.onmessage = ({ data: buf }) => {
      if (this._ws?.readyState === WebSocket.OPEN) this._ws.send(buf);
    };

    this._sourceNode = this._audioCtx.createMediaStreamSource(mediaStream);
    this._sourceNode.connect(this._workletNode);
  }

  // The biggest latency win in Go Live: don't wait for Sarvam's final
  // transcript if we already have a good partial. Sarvam's "final" is
  // typically the last partial with minor cleanup (punctuation, casing);
  // it can arrive anywhere from 100ms to several seconds after we close the
  // socket. Returning `_lastPartial` immediately shaves 1–4s off each turn.
  // If the final happens to arrive within `maxWaitMs`, prefer it.
  async stop(maxWaitMs = 250) {
    this._stopped = true;
    try { this._sourceNode?.disconnect(); } catch {}
    try { this._workletNode?.disconnect(); } catch {}
    try { this._audioCtx?.close(); } catch {}
    this._sourceNode = null;
    this._workletNode = null;
    this._audioCtx = null;

    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.close(1000, 'end-of-speech');
    }

    if (this._lastPartial) {
      const cleanFinal = Promise.race([
        this._finalPromise,
        new Promise((r) => setTimeout(() => r(this._lastPartial), maxWaitMs)),
      ]);
      const result = await cleanFinal;
      this._ws = null;
      return (result || this._lastPartial || '').trim();
    }

    // No partial at all — a very short utterance. Give the server a bit
    // more time since we have nothing to fall back on.
    const result = await Promise.race([
      this._finalPromise,
      new Promise((r) => setTimeout(() => r(''), 1200)),
    ]);
    this._ws = null;
    return (result || '').trim();
  }

  destroy() {
    this._stopped = true;
    try { this._sourceNode?.disconnect(); } catch {}
    try { this._workletNode?.disconnect(); } catch {}
    try { this._audioCtx?.close(); } catch {}
    try { this._ws?.close(); } catch {}
  }
}
