// audio.js — minimal PCM helpers for the LiveKit media path. No native deps.
//
//  • parseWav    — extract { sampleRate, channels, pcm } from a WAV buffer
//                  (Bulbul returns WAV; we request LINEAR16/WAV from Google too).
//  • resampleInt16 — linear resampler between sample rates (e.g. LiveKit's
//                  48 kHz capture → 16 kHz for Sarvam STT; TTS rate → 24 kHz
//                  for the outbound LiveKit track).
//  • downmixToMono — average channels if a frame arrives as stereo.

// Parse a PCM WAV buffer. Returns { sampleRate, channels, pcm: Int16Array }.
export function parseWav(buf) {
  // Locate the 'fmt ' and 'data' chunks rather than assuming a 44-byte header.
  let offset = 12; // skip RIFF....WAVE
  let sampleRate = 16000, channels = 1, dataStart = 44, dataLen = buf.length - 44;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels   = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
    } else if (id === 'data') {
      dataStart = offset + 8;
      dataLen = size;
      break;
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  const pcm = new Int16Array(buf.buffer, buf.byteOffset + dataStart, Math.floor(dataLen / 2));
  return { sampleRate, channels, pcm };
}

// Linear-interpolation resampler. Good enough for speech; avoids a native dep.
export function resampleInt16(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.floor(input.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    out[i] = (input[i0] * (1 - frac) + input[i1] * frac) | 0;
  }
  return out;
}

export function downmixToMono(input, channels) {
  if (channels <= 1) return input;
  const outLen = Math.floor(input.length / channels);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += input[i * channels + c];
    out[i] = (sum / channels) | 0;
  }
  return out;
}

// Convert an Int16Array to a Node Buffer (little-endian) for VAD/STT WAV wrapping.
export function int16ToBuffer(int16) {
  return Buffer.from(int16.buffer, int16.byteOffset, int16.byteLength);
}
