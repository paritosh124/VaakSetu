// Sarvam streaming STT for the extension. Ported from src/api/sarvam-streaming.js.
// Key differences vs webapp:
//   - No Vite env — key is fetched once from /api/sarvam-ws-key and cached.
//   - AudioContext is created from the passed-in MediaStream source (tab or mic).
//   - Runs inside the offscreen document (behaves like a normal page).
//   - onFinal callback fires on transcript arrival for the Phase-1 fast path.
import { API_BASE } from '../config.js';
import { authedFetch } from '../auth.js';

const WS_BASE = 'wss://api.sarvam.ai';

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

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

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
  constructor({ languageCode, mode = 'translate', onPartial, onFinal }) {
    this.languageCode = languageCode;
    this.mode         = mode;
    this.onPartial    = onPartial; // no-op in new API — no partials; kept for interface compat
    this.onFinal      = onFinal;  // fires on transcript receipt — used for Phase-1 fast path

    this._ws          = null;
    this._audioCtx    = null;
    this._workletNode = null;
    this._sourceNode  = null;
    this._result      = '';
    this._stopped     = false;
    this._finalPromise = new Promise((res, rej) => {
      this._finalResolve = res;
      this._finalReject  = rej;
    });
  }

  async start(mediaStream) {
    const apiKey = await getKey();
    if (!apiKey) throw new Error('No Sarvam key available for streaming');

    const isTranslate = this.mode === 'translate';
    const path = isTranslate
      ? '/speech-to-text-translate/ws'
      : '/speech-to-text/ws';

    const sttCode = this.languageCode === 'od-IN' ? 'or-IN' : this.languageCode;

    const params = new URLSearchParams({
      model:             'saaras:v3',
      sample_rate:       '16000',
      input_audio_codec: 'pcm_s16le',
      flush_signal:      'true',
    });
    if (!isTranslate) params.set('language-code', sttCode);

    const url = `${WS_BASE}${path}?${params}`;
    console.log(`[vaaksetu streaming] opening WS path=${path} key prefix=${apiKey.slice(0, 6)} len=${apiKey.length}`);

    // Auth via subprotocol — browsers can't set custom WS headers
    const ws = new WebSocket(url, [`api-subscription-key.${apiKey}`]);
    this._ws = ws;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connection timed out after 6s')), 6000);
      ws.onopen = () => {
        clearTimeout(t);
        console.log('[vaaksetu streaming] WS open');
        resolve();
      };
      ws.onerror = (ev) => {
        clearTimeout(t);
        console.error('[vaaksetu streaming] WS error on connect', ev);
        reject(new Error('WebSocket handshake failed'));
      };
      ws.onclose = (ev) => {
        if (ws.readyState !== WebSocket.OPEN && !this._stopped) {
          clearTimeout(t);
          console.error(`[vaaksetu streaming] WS closed before open code=${ev.code} reason=${ev.reason || '(none)'}`);
          reject(new Error(`WebSocket closed before open: code=${ev.code}`));
        }
      };
    });

    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'transcript' || msg.type === 'translation') {
        const text = (msg.text || '').trim();
        this._result = text;
        this._finalResolve(text);
        // Fire onFinal for Phase-1 receiveFinal() fast path (if activeCapture is still set)
        if (text) this.onFinal?.(text);
      }
    };

    ws.onclose = () => {
      // Fallback resolve in case flush response never arrived
      this._finalResolve(this._result);
    };

    ws.onerror = () => {
      this._finalReject(new Error('WebSocket error during streaming'));
    };

    const AC = self.AudioContext || self.webkitAudioContext;
    this._audioCtx = new AC({ sampleRate: 16000 });
    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this._audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this._workletNode = new AudioWorkletNode(this._audioCtx, 'vs-pcm-processor');
    this._workletNode.port.onmessage = ({ data: buf }) => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({
          audio: {
            data:        bufToBase64(buf),
            sample_rate: 16000,
            encoding:    'audio/x-raw',
          },
        }));
      }
    };

    this._sourceNode = this._audioCtx.createMediaStreamSource(mediaStream);
    this._sourceNode.connect(this._workletNode);
  }

  // Send flush → wait for transcript. maxWaitMs is the fallback timeout.
  async stop(maxWaitMs = 1500) {
    this._stopped = true;

    try { this._sourceNode?.disconnect(); } catch {}
    try { this._workletNode?.disconnect(); } catch {}
    try { this._audioCtx?.close(); }        catch {}
    this._sourceNode  = null;
    this._workletNode = null;
    this._audioCtx    = null;

    const t0 = Date.now();
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'flush' }));
    }

    const result = await Promise.race([
      this._finalPromise,
      new Promise((r) => setTimeout(() => r(this._result), maxWaitMs)),
    ]);

    console.log(`[vaaksetu streaming] stop() took ${Date.now() - t0}ms result="${(result || '').slice(0, 60)}"`);

    try { this._ws?.close(1000); } catch {}
    this._ws = null;
    return (result || '').trim();
  }

  destroy() {
    this._stopped = true;
    try { this._sourceNode?.disconnect(); } catch {}
    try { this._workletNode?.disconnect(); } catch {}
    try { this._audioCtx?.close(); }        catch {}
    try { this._ws?.close(); }              catch {}
  }
}
