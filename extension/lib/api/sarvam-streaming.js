// Sarvam streaming STT for the extension. Ported from src/api/sarvam-streaming.js.
// Key differences vs webapp:
//   - No Vite env — key is fetched once from /api/sarvam-ws-key and cached.
//   - AudioContext is created from the passed-in MediaStream source (tab or mic).
//   - Runs inside the offscreen document, which behaves like a normal page.
import { API_BASE } from '../config.js';

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
  const res = await fetch(`${API_BASE}/sarvam-ws-key`);
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
    const ws = new WebSocket(url);
    this._ws = ws;
    ws.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connection timed out')), 6000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket connection failed')); };
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

  async stop(timeoutMs = 4000) {
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

    const timeout = new Promise((resolve) => setTimeout(() => resolve(this._lastPartial), timeoutMs));
    const result = await Promise.race([this._finalPromise, timeout]);
    this._ws = null;
    return result || '';
  }

  destroy() {
    this._stopped = true;
    try { this._sourceNode?.disconnect(); } catch {}
    try { this._workletNode?.disconnect(); } catch {}
    try { this._audioCtx?.close(); } catch {}
    try { this._ws?.close(); } catch {}
  }
}
