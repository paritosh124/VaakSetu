// vad.js — energy-based voice-activity detection over a raw PCM stream.
//
// Ported from the extension's createVadLoop / webapp startSilenceDetection
// (already field-tuned). Used for the CUSTOMER side, whose audio arrives as a
// continuous PCM stream from Recall and must be segmented into utterances.
//
// The agent side does NOT use this — the browser segments the agent's mic
// locally and sends complete utterance blobs, matching the existing webapp PTT
// pattern.
//
// Feed it 16-bit PCM chunks via push(); it calls onUtterance(Buffer) with the
// accumulated PCM when a complete utterance (speech then sustained silence) is
// detected.

import { VAD, SAMPLE_RATE } from './config.js';

export function createPcmVad({ onUtterance, onSpeechStart } = {}) {
  let speaking = false;
  let activeMs = 0;       // accumulated speech time toward MIN_SPEECH_MS
  let silenceMs = 0;      // sustained silence once armed
  let gapMs = 0;          // current run of sub-threshold samples
  let buffer = [];        // Buffers collected for the current utterance

  // RMS of an Int16 PCM chunk, scaled to a ~0–128 range and gain-boosted 16×
  // to match the extension's tuned threshold on AGC-compressed signals.
  function rms(chunk) {
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.length / 2));
    if (samples.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] / 32768; // -1..1
      sum += v * v;
    }
    const r = Math.sqrt(sum / samples.length); // 0..1
    return Math.min(128, r * 128 * 16);         // scale + 16× boost
  }

  function push(chunk) {
    const level = rms(chunk);
    // ms represented by this chunk (16-bit mono): bytes / 2 / sampleRate * 1000
    const dtMs = Math.min(200, (chunk.length / 2 / SAMPLE_RATE) * 1000);
    const active = level >= VAD.SILENCE_THRESHOLD;

    if (active) {
      if (!speaking) { speaking = true; activeMs = 0; buffer = []; onSpeechStart?.(); }
      activeMs += dtMs;
      gapMs = 0;
      silenceMs = 0;
      buffer.push(Buffer.from(chunk));
    } else if (speaking) {
      buffer.push(Buffer.from(chunk)); // keep trailing audio for natural endings
      gapMs += dtMs;
      // Gap-tolerant: short inter-word pauses don't reset the speech accumulator.
      if (gapMs <= VAD.GAP_TOLERANCE_MS) {
        // still mid-utterance
      } else if (activeMs >= VAD.MIN_SPEECH_MS) {
        // armed — count sustained silence toward end-of-utterance
        silenceMs += dtMs;
        if (silenceMs >= VAD.SILENCE_MS) flush();
      } else {
        // not enough real speech yet — treat as a false start, reset
        reset();
      }
    }
  }

  function flush() {
    const utter = buffer.length ? Buffer.concat(buffer) : null;
    reset();
    if (utter && utter.length > 0) onUtterance?.(utter);
  }

  function reset() {
    speaking = false;
    activeMs = 0;
    silenceMs = 0;
    gapMs = 0;
    buffer = [];
  }

  return { push, flush, reset };
}
