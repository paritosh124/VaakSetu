// livekit.js — the relay's server-side participant.
//
// The relay joins the customer's LiveKit room as "vaaksetu-translator":
//   • subscribes to the customer's mic track → PCM frames → onCustomerPcm(buf16k)
//     (the relay feeds these into the existing VAD → turn queue)
//   • exposes inject(wavBuffer) → publishes the agent's translated speech back
//     into the room so the customer hears it.
//
// Replaces the Recall.ai transport. The agent side is unchanged (our own WS).
//
// Requires: livekit-server-sdk (token mint) + @livekit/rtc-node (realtime media,
// native bindings — installed on the relay host, not in the Vite bundle).
// ⚠️ FIRST-RUN: @livekit/rtc-node export names / AudioFrame signature may differ
// slightly by version — verify against the installed version on first deploy.

import { AccessToken } from 'livekit-server-sdk';
import {
  Room, RoomEvent, TrackKind, AudioStream, AudioSource,
  LocalAudioTrack, AudioFrame, TrackPublishOptions, TrackSource,
} from '@livekit/rtc-node';
import {
  LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
  SAMPLE_RATE, INJECT_SAMPLE_RATE,
} from './config.js';
import { parseWav, resampleInt16, downmixToMono, int16ToBuffer } from './audio.js';

// Mint a join token. `canPublish`/`canSubscribe` default true. Used both for the
// relay's own join and (from the Vercel control plane) for the customer.
export async function mintToken({ roomName, identity, name, ttlSeconds = 7200 }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, name, ttl: ttlSeconds });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  return at.toJwt();
}

// Connect the relay to a room. Returns a handle with inject() + disconnect().
//   onCustomerPcm(Buffer)  — mono 16 kHz Int16 PCM, ready for VAD/STT
//   onStatus(state)        — 'waiting-for-customer' | 'live' | 'customer-left'
export async function joinRoomAsTranslator({ roomName, onCustomerPcm, onStatus }) {
  if (!LIVEKIT_URL) throw new Error('LIVEKIT_URL not configured');
  const token = await mintToken({ roomName, identity: 'vaaksetu-translator', name: 'VaakSetu' });

  const room = new Room();
  await room.connect(LIVEKIT_URL, token, { autoSubscribe: true, dynacast: true });

  // ── Outbound track for injecting translated speech ──────────────────────────
  const source = new AudioSource(INJECT_SAMPLE_RATE, 1);
  const localTrack = LocalAudioTrack.createAudioTrack('vaaksetu-tts', source);
  await room.localParticipant.publishTrack(
    localTrack,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );

  // ── Subscribe to the customer's mic ─────────────────────────────────────────
  const pumps = new Set();
  room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
    if (participant.identity === 'vaaksetu-translator') return; // ignore our own
    if (track.kind !== TrackKind.KIND_AUDIO) return;
    onStatus?.('live');
    const stream = new AudioStream(track);
    const pump = (async () => {
      for await (const frame of stream) {
        // frame.data: Int16Array, frame.sampleRate, frame.channels
        let pcm = frame.data;
        if (frame.channels > 1) pcm = downmixToMono(pcm, frame.channels);
        if (frame.sampleRate !== SAMPLE_RATE) pcm = resampleInt16(pcm, frame.sampleRate, SAMPLE_RATE);
        onCustomerPcm?.(int16ToBuffer(pcm));
      }
    })();
    pumps.add(pump);
  });

  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    if (p.identity !== 'vaaksetu-translator') onStatus?.('customer-left');
  });

  onStatus?.('waiting-for-customer');

  // Inject a TTS clip (WAV/PCM) into the room.
  async function inject(wavBuffer) {
    const { sampleRate, channels, pcm } = parseWav(wavBuffer);
    let mono = channels > 1 ? downmixToMono(pcm, channels) : pcm;
    const data = resampleInt16(mono, sampleRate, INJECT_SAMPLE_RATE);
    // Push in ~10ms frames so LiveKit paces playback smoothly.
    const frameSize = Math.floor(INJECT_SAMPLE_RATE / 100); // 10ms
    for (let i = 0; i < data.length; i += frameSize) {
      const slice = data.subarray(i, Math.min(i + frameSize, data.length));
      const frame = new AudioFrame(slice, INJECT_SAMPLE_RATE, 1, slice.length);
      await source.captureFrame(frame);
    }
  }

  async function disconnect() {
    try { await room.disconnect(); } catch {}
  }

  return { room, inject, disconnect };
}
