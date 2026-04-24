// Wraps SarvamStreamingSTT to emit per-sentence events as partials arrive.
// Instead of waiting for the speaker to pause, we fire translate+TTS as soon
// as each sentence is recognizable — the listener hears the translated first
// sentence while the speaker is still producing the second. Biggest perceived
// latency win without switching TTS providers.
//
// Boundaries detected on:
//   • Terminal punctuation (. ! ? ।  ॥  。) followed by whitespace / end.
//   • A stable partial (no new text for IDLE_FLUSH_MS) of reasonable length —
//     handles Saaras not always emitting punctuation in time.
//
// On stop(): any leftover unsettled text is flushed as the final sentence.
import { SarvamStreamingSTT, supportsStreamingSTT } from './sarvam-streaming.js';

const SENTENCE_END_RE = /[.!?।॥。]/;
const IDLE_FLUSH_MS   = 650;
const IDLE_MIN_CHARS  = 15;
const MIN_SENTENCE    = 2;

export class SarvamSentenceStreamer {
  constructor({ languageCode, mode, onSentence, onPartial }) {
    this.onSentence = onSentence;
    this.onPartial = onPartial;
    this._stream = new SarvamStreamingSTT({
      languageCode, mode,
      onPartial: (t) => this._handlePartial(t),
    });
    this._lastPartialText = '';
    this._lastChangeAt = Date.now();
    this._settled = 0;       // number of chars already emitted as sentences
    this._idleTimer = null;
    this._stopped = false;
  }

  async start(mediaStream) {
    await this._stream.start(mediaStream);
    this._idleTimer = setInterval(() => this._checkIdle(), 150);
  }

  _handlePartial(text) {
    if (text === this._lastPartialText) return;
    this._lastPartialText = text;
    this._lastChangeAt = Date.now();
    this.onPartial?.(text);
    this._emitFinishedSentences();
  }

  _emitFinishedSentences() {
    const text = this._lastPartialText;
    while (this._settled < text.length) {
      const tail = text.slice(this._settled);
      const m = tail.match(SENTENCE_END_RE);
      if (!m) break;
      const endAbs = this._settled + m.index + 1; // include punctuation
      const sentence = text.slice(this._settled, endAbs).trim();
      this._settled = endAbs;
      if (sentence.length >= MIN_SENTENCE) this.onSentence?.(sentence, false);
    }
  }

  _checkIdle() {
    if (this._stopped) return;
    const text = this._lastPartialText;
    const unsettled = text.slice(this._settled).trim();
    if (unsettled.length >= IDLE_MIN_CHARS &&
        Date.now() - this._lastChangeAt >= IDLE_FLUSH_MS) {
      this._settled = text.length;
      this.onSentence?.(unsettled, false);
    }
  }

  async stop() {
    this._stopped = true;
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    const final = await this._stream.stop();
    const full = final || this._lastPartialText;
    // Catch sentences that appeared only in the final transcript.
    this._lastPartialText = full;
    this._emitFinishedSentences();
    const unsettled = full.slice(this._settled).trim();
    if (unsettled.length >= 1) {
      this._settled = full.length;
      this.onSentence?.(unsettled, true);
    }
    return full;
  }

  destroy() {
    this._stopped = true;
    if (this._idleTimer) { clearInterval(this._idleTimer); this._idleTimer = null; }
    this._stream.destroy();
  }
}

export { supportsStreamingSTT };
