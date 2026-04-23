/**
 * sarvam-streaming.js — Real-time STT via Sarvam WebSocket
 *
 * Protocol (per Sarvam docs):
 *   1. Connect: wss://api.sarvam.ai/speech-to-text/streaming?api-subscription-key=KEY
 *   2. Send config JSON: { model, mode, language_code, sample_rate }
 *   3. Send audio: binary Int16 PCM frames (16 kHz, mono, little-endian)
 *   4. Receive JSON: { transcript, is_final } — repeated partials, then one final
 *   5. End: close WebSocket (normal close 1000) to signal end of stream
 *
 * NOTE: API key is sent in the WebSocket URL query param and is visible in
 * browser devtools Network tab. Accepted trade-off for this project.
 */

// AudioWorklet processor — captures microphone as Int16 PCM chunks
// Loaded as a Blob URL so no separate public/ file is needed
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

export class SarvamStreamingSTT {
  /**
   * @param {object} opts
   * @param {string}   opts.apiKey        — Sarvam API subscription key
   * @param {string}   opts.languageCode  — e.g. 'hi-IN', 'te-IN'
   * @param {string}   [opts.mode]        — 'translate' | 'transcribe' (default: 'translate')
   * @param {Function} [opts.onPartial]   — (text) => void — called on each interim result
   */
  constructor({ apiKey, languageCode, mode = 'translate', onPartial }) {
    this.apiKey = apiKey;
    this.languageCode = languageCode;
    this.mode = mode;
    this.onPartial = onPartial;

    this._ws = null;
    this._audioCtx = null;
    this._workletNode = null;
    this._sourceNode = null;
    this._lastPartial = '';
    this._finalResolve = null;
    this._finalReject = null;
    this._finalPromise = new Promise((res, rej) => {
      this._finalResolve = res;
      this._finalReject = rej;
    });
    this._stopped = false;
  }

  /**
   * Start streaming. Call synchronously inside or immediately after getUserMedia.
   * @param {MediaStream} mediaStream
   * @returns {Promise<void>} resolves when WebSocket is open and AudioWorklet is ready
   */
  async start(mediaStream) {
    // ── Connect WebSocket ────────────────────────────────────────────────────
    const url = `${WS_URL}?api-subscription-key=${this.apiKey}`;
    const ws = new WebSocket(url);
    this._ws = ws;
    ws.binaryType = 'arraybuffer';

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connection timed out')), 6000);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket connection failed')); };
    });

    // Send initial config
    // STT streaming also uses 'or-IN' for Odia (same as batch STT)
    const sttCode = this.languageCode === 'od-IN' ? 'or-IN' : this.languageCode;
    ws.send(JSON.stringify({
      model: 'saaras:v3',
      mode: this.mode,
      language_code: sttCode,
    }));

    // Handle messages
    ws.onmessage = (evt) => {
      let data;
      try { data = JSON.parse(evt.data); } catch { return; }

      // Normalise field names — Sarvam may use 'transcript' or 'text'
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

    ws.onclose = (evt) => {
      // If we never got an explicit is_final, resolve with last partial
      if (!this._stopped) return; // unexpected close
      this._finalResolve(this._lastPartial);
    };

    ws.onerror = () => {
      this._finalReject(new Error('WebSocket error during streaming'));
    };

    // ── Set up AudioWorklet for PCM capture ──────────────────────────────────
    // Force 16 kHz to minimise upload size; browser resamples from native rate
    this._audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });

    const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this._audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this._workletNode = new AudioWorkletNode(this._audioCtx, 'vs-pcm-processor');
    this._workletNode.port.onmessage = ({ data: buf }) => {
      if (this._ws?.readyState === WebSocket.OPEN) {
        this._ws.send(buf);
      }
    };

    this._sourceNode = this._audioCtx.createMediaStreamSource(mediaStream);
    this._sourceNode.connect(this._workletNode);
    // Don't connect workletNode to destination — we don't want to hear ourselves
  }

  /**
   * Stop recording and return the transcript.
   *
   * The biggest latency win in Go Live / auto-stop: don't block on Sarvam's
   * explicit "final" message when we already have a good partial. Sarvam's
   * final is typically the last partial with punctuation/casing cleanup, and
   * it can arrive anywhere from 100ms to several seconds after socket close.
   * Returning `_lastPartial` immediately shaves 1–4s off each turn. If the
   * final happens to arrive within `maxWaitMs`, we use that instead.
   *
   * @param {number} [maxWaitMs=250]  brief grace window for a cleaner final
   * @returns {Promise<string>}       English pivot (mode=translate) or verbatim text
   */
  async stop(maxWaitMs = 250) {
    this._stopped = true;

    // Disconnect audio pipeline
    try { this._sourceNode?.disconnect(); } catch {}
    try { this._workletNode?.disconnect(); } catch {}
    try { this._audioCtx?.close(); } catch {}
    this._sourceNode = null;
    this._workletNode = null;
    this._audioCtx = null;

    // Signal end of audio to Sarvam — closing the socket triggers final response
    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.close(1000, 'end-of-speech');
    }

    if (this._lastPartial) {
      // Fast path: race the final against a short window; fall back to partial.
      const result = await Promise.race([
        this._finalPromise,
        new Promise((r) => setTimeout(() => r(this._lastPartial), maxWaitMs)),
      ]);
      this._ws = null;
      return (result || this._lastPartial || '').trim();
    }

    // No partial at all — very short utterance. Give the server a bit more
    // time since we have nothing to fall back on.
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

/** Returns true if the browser supports AudioWorklet (Chrome, Safari 14.5+, Firefox) */
export function supportsStreamingSTT() {
  return typeof AudioWorkletNode !== 'undefined' && typeof WebSocket !== 'undefined';
}
