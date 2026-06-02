/**
 * sarvam-streaming.js — Real-time STT via Sarvam WebSocket
 *
 * Protocol (Sarvam SDK v1.1.7):
 *   mode=translate  → wss://api.sarvam.ai/speech-to-text-translate/ws
 *   mode=transcribe → wss://api.sarvam.ai/speech-to-text/ws?language-code=<code>
 *
 *   Auth: WebSocket subprotocol `api-subscription-key.<KEY>` (not a query param)
 *   Config: URL query params (model, sample_rate, input_audio_codec, flush_signal)
 *   Audio: JSON { audio: { data: base64(Int16PCM), sample_rate: 16000, encoding: "audio/x-raw" } }
 *   Stop:  send { type: "flush" } → receive { type: "transcript"/"translation", text: "..." }
 */

const WS_BASE = 'wss://api.sarvam.ai';

// AudioWorklet: captures mic as Int16 PCM at 16 kHz, transfers zero-copy
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

export class SarvamStreamingSTT {
  /**
   * @param {object} opts
   * @param {string}   opts.apiKey        — Sarvam API subscription key
   * @param {string}   opts.languageCode  — e.g. 'hi-IN', 'te-IN'
   * @param {string}   [opts.mode]        — 'translate' (→ English) | 'transcribe' (verbatim)
   * @param {Function} [opts.onPartial]   — no-op; kept for interface compatibility (API has no partials)
   */
  constructor({ apiKey, languageCode, mode = 'translate', onPartial, onFinal }) {
    this.apiKey       = apiKey;
    this.languageCode = languageCode;
    this.mode         = mode;
    this.onPartial    = onPartial; // retained for interface compat — never fires in new API
    this.onFinal      = onFinal;   // fires immediately when transcript arrives (before stop() is called)

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

  /**
   * Start streaming. Call synchronously inside or immediately after getUserMedia.
   * @param {MediaStream} mediaStream
   * @returns {Promise<void>} resolves when WebSocket is open and AudioWorklet is ready
   */
  async start(mediaStream) {
    const isTranslate = this.mode === 'translate';
    const path = isTranslate
      ? '/speech-to-text-translate/ws'
      : '/speech-to-text/ws';

    // Odia: STT uses or-IN
    const sttCode = this.languageCode === 'od-IN' ? 'or-IN' : this.languageCode;

    const params = new URLSearchParams({
      model:             'saaras:v3',
      sample_rate:       '16000',
      input_audio_codec: 'pcm_s16le',
      flush_signal:      'true',
    });
    if (!isTranslate) params.set('language-code', sttCode);

    const url = `${WS_BASE}${path}?${params}`;
    // Auth via WebSocket subprotocol — browsers can't set custom WS headers
    const ws = new WebSocket(url, [`api-subscription-key.${this.apiKey}`]);
    this._ws = ws;

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connection timed out')), 6000);
      ws.onopen  = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket connection failed')); };
    });

    ws.onmessage = ({ data }) => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (msg.type === 'transcript' || msg.type === 'translation') {
        this._result = (msg.text || '').trim();
        this._finalResolve(this._result);
        // Fire after resolving so stop() called from onFinal sees the result immediately
        this.onFinal?.(this._result);
      }
    };

    ws.onclose = () => {
      // Fallback: resolve with whatever we have (covers unexpected close)
      this._finalResolve(this._result);
    };

    ws.onerror = () => {
      this._finalReject(new Error('WebSocket error during streaming'));
    };

    // AudioWorklet at 16 kHz — browser resamples from native rate
    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

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

  /**
   * Stop recording. Sends flush → waits for final transcript.
   * @param {number} [timeoutMs=2000]
   * @returns {Promise<string>}
   */
  async stop(timeoutMs = 1500) {
    this._stopped = true;

    try { this._sourceNode?.disconnect(); } catch {}
    try { this._workletNode?.disconnect(); } catch {}
    try { this._audioCtx?.close(); }        catch {}
    this._sourceNode  = null;
    this._workletNode = null;
    this._audioCtx    = null;

    // flush = ask Sarvam to finalize the transcript immediately
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ type: 'flush' }));
    }

    const result = await Promise.race([
      this._finalPromise,
      new Promise((r) => setTimeout(() => r(this._result), timeoutMs)),
    ]);

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

/** Returns true if the browser supports AudioWorklet + WebSocket */
export function supportsStreamingSTT() {
  return typeof AudioWorkletNode !== 'undefined' && typeof WebSocket !== 'undefined';
}
