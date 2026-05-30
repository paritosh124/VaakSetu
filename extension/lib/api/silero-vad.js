// Silero VAD v4 — neural speech probability via onnxruntime-web.
//
// Requires three files in the extension bundle (run scripts/download-silero.sh):
//   extension/lib/ort/ort.min.js          — JS wrapper (loaded as global in offscreen.html)
//   extension/lib/ort/ort-wasm-simd.wasm  — WASM backend (loaded by ort at runtime)
//   extension/lib/silero_vad.onnx         — the model
//
// Interface: matches createVadLoop() return value — stop(), pause(), resume(), rms().
// start() is async; await it before the VAD becomes active.
//
// Model I/O (Silero v4, 16 kHz):
//   Inputs : input[1,512] float32, h[2,1,64] float32, c[2,1,64] float32, sr[1] int64
//   Outputs: output[1,1] float32 (prob), hn[2,1,64], cn[2,1,64]
//   Window : 512 samples = 32 ms  (AudioContext forced to 16 kHz; browser resamples)

// AudioWorklet: collects 512-sample windows from the 16 kHz AudioContext and posts
// them (zero-copy transfer) + per-quantum RMS for no-signal detection.
const WORKLET_SRC = `
class SileroSamplerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(512);
    this._pos = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let sum = 0;
    for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
    const rms = Math.sqrt(sum / ch.length);
    for (let i = 0; i < ch.length; i++) {
      this._buf[this._pos++] = ch[i];
      if (this._pos >= 512) {
        const payload = this._buf;
        this._buf = new Float32Array(512);
        // Transfer payload buffer (zero-copy). Receiver wraps it in Float32Array.
        this.port.postMessage({ samples: payload, rms }, [payload.buffer]);
        this._pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('silero-sampler', SileroSamplerProcessor);
`;

// Tuned for call-center use: fast response, tolerant of natural sentence pauses.
const START_THRESHOLD  = 0.5;   // prob ≥ this → speech frame
const END_THRESHOLD    = 0.35;  // prob < this → silence frame (hysteresis gap)
const MIN_SPEECH_MS    = 300;   // accumulated speech before arming (shorter than energy VAD
                                //   because Silero suppresses noise reliably)
const SILENCE_MS       = 800;   // sustained silence to close the turn
const NO_SIGNAL_WARN_MS       = 8000;  // ms before firing onNoSignal
const NO_SIGNAL_RMS_THRESHOLD = 0.002; // float32 amplitude (no gain boost — raw stream)

// Load the shared ONNX session. Call once in startGoLive; pass the session to
// each SileroVAD instance (they share the model weights but keep per-stream
// LSTM state separately).
export async function loadSileroSession() {
  const ort = self.ort;
  if (!ort) {
    throw new Error(
      'onnxruntime-web not loaded — add <script src="../lib/ort/ort.min.js"> to offscreen.html'
    );
  }
  // Point ort at the local WASM files so it doesn't try to fetch from CDN.
  ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/');
  const modelUrl = chrome.runtime.getURL('lib/silero_vad.onnx');
  const session = await ort.InferenceSession.create(modelUrl, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
  console.log('[silero-vad] session loaded — inputs:', session.inputNames, 'outputs:', session.outputNames);
  return session;
}

export class SileroVAD {
  constructor({ session, stream, onSpeechStart, onSpeechEnd, onNoSignal }) {
    this._session       = session;
    this._stream        = stream;
    this.onSpeechStart  = onSpeechStart;
    this.onSpeechEnd    = onSpeechEnd;
    this.onNoSignal     = onNoSignal;

    this._ac            = null;
    this._workletNode   = null;
    this._src           = null;

    // Per-stream LSTM state — reset on pause() so stale context doesn't bleed.
    this._h = null;
    this._c = null;
    this._resetLSTMState();

    this._armed         = false;
    this._speechMs      = 0;
    this._silentMs      = 0;
    this._lastWindowAt  = Date.now();
    this._paused        = false;
    this._inferring     = false;   // serialise inference — drop windows if falling behind

    this._lastRms       = 0;
    this._noSignalMs    = 0;
    this._warnedNoSignal = false;

    // Detect output tensor names — Silero v4 uses hn/cn; some exports use stateH/stateC.
    const outNames = session.outputNames;
    this._hOutName = outNames.find(n => /^h/i.test(n) && n !== 'h') ?? 'hn';
    this._cOutName = outNames.find(n => /^c/i.test(n) && n !== 'c') ?? 'cn';

    // Detect whether the model wants a 'sr' (sample rate) input.
    this._hasSrInput = session.inputNames.includes('sr');
  }

  _resetLSTMState() {
    const ort = self.ort;
    const zeros = () => new Float32Array(2 * 1 * 64);
    this._h = new ort.Tensor('float32', zeros(), [2, 1, 64]);
    this._c = new ort.Tensor('float32', zeros(), [2, 1, 64]);
  }

  async start() {
    // Force AudioContext to 16 kHz — browser resamples the MediaStream automatically.
    // This lets the worklet collect raw 512-sample windows without decimation logic.
    const AC = self.AudioContext || self.webkitAudioContext;
    this._ac = new AC({ sampleRate: 16000 });
    await this._ac.resume().catch((e) => console.warn('[silero-vad] ctx resume:', e));

    const blob   = new Blob([WORKLET_SRC], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this._ac.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this._workletNode = new AudioWorkletNode(this._ac, 'silero-sampler');
    this._workletNode.port.onmessage = ({ data }) => {
      // data.samples is a Float32Array backed by a transferred ArrayBuffer.
      this._onWindow(data.samples, data.rms);
    };

    this._src = this._ac.createMediaStreamSource(this._stream);
    // Terminate into a muted gain node so Chromium doesn't prune the subgraph.
    const mute = this._ac.createGain();
    mute.gain.value = 0;
    this._src.connect(this._workletNode);
    this._workletNode.connect(mute);
    mute.connect(this._ac.destination);

    this._lastWindowAt = Date.now();
  }

  // Called every ~32 ms (512 samples at 16 kHz) — runs ONNX inference.
  _onWindow(samples, rms) {
    if (this._paused || this._inferring) return;
    this._inferring = true;
    this._lastRms   = rms;

    // No-signal detection (uses raw float32 amplitude — no software gain boost).
    if (rms < NO_SIGNAL_RMS_THRESHOLD) {
      this._noSignalMs += 32;
    } else {
      this._noSignalMs = 0;
    }
    if (!this._warnedNoSignal && this._noSignalMs >= NO_SIGNAL_WARN_MS) {
      this._warnedNoSignal = true;
      console.warn(`[silero-vad] NO SIGNAL after ${NO_SIGNAL_WARN_MS}ms — rms < ${NO_SIGNAL_RMS_THRESHOLD}`);
      this.onNoSignal?.();
    }

    const ort = self.ort;
    const f32  = samples instanceof Float32Array ? samples : new Float32Array(samples);
    const feeds = {
      input: new ort.Tensor('float32', f32, [1, 512]),
      h: this._h,
      c: this._c,
    };
    if (this._hasSrInput) {
      const srBuf = new BigInt64Array(1);
      srBuf[0] = BigInt(16000);
      feeds.sr = new ort.Tensor('int64', srBuf, [1]);
    }

    this._session.run(feeds)
      .then((results) => {
        const prob   = results.output.data[0];
        this._h      = results[this._hOutName];
        this._c      = results[this._cOutName];
        this._inferring = false;
        this._updateState(prob);
      })
      .catch((err) => {
        console.error('[silero-vad] inference error:', err?.message);
        this._inferring = false;
      });
  }

  _updateState(prob) {
    const now = Date.now();
    const dt  = Math.min(200, now - this._lastWindowAt);
    this._lastWindowAt = now;

    if (prob >= START_THRESHOLD) {
      this._speechMs += dt;
      this._silentMs  = 0;
      if (!this._armed && this._speechMs >= MIN_SPEECH_MS) {
        this._armed = true;
        console.log(`[silero-vad] speech-start prob=${prob.toFixed(2)} speechMs=${this._speechMs}`);
        this.onSpeechStart?.();
      }
    } else if (prob < END_THRESHOLD) {
      this._silentMs += dt;
      if (!this._armed) {
        this._speechMs = 0; // reset pre-arm accumulator
      } else if (this._silentMs >= SILENCE_MS) {
        this._armed    = false;
        this._speechMs = 0;
        this._silentMs = 0;
        console.log(`[silero-vad] speech-end prob=${prob.toFixed(2)}`);
        this.onSpeechEnd?.();
      }
    }
    // Hysteresis zone (END_THRESHOLD ≤ prob < START_THRESHOLD): hold current state.
  }

  pause() {
    this._paused    = true;
    this._armed     = false;
    this._speechMs  = 0;
    this._silentMs  = 0;
    this._resetLSTMState(); // discard context so next turn starts clean
  }

  resume() {
    this._paused       = false;
    this._armed        = false;
    this._speechMs     = 0;
    this._silentMs     = 0;
    this._lastWindowAt = Date.now();
  }

  rms() { return this._lastRms; }

  stop() {
    this._paused = true;
    try { this._src?.disconnect(); }          catch {}
    try { this._workletNode?.disconnect(); }  catch {}
    try { this._ac?.close(); }                catch {}
    this._src = this._workletNode = this._ac = null;
  }
}
