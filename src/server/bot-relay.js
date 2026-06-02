// bot-relay.js — the heart of the Meeting Bot.
//
// Audio sources for a session:
//   • AGENT browser  (WS /agent?sessionId=…): receives translated customer
//     audio + transcripts; sends the agent's own utterance blobs (browser does
//     local VAD, sends complete utterances — matches the webapp PTT pattern).
//   • CUSTOMER        (LiveKit room): the relay joins as a server participant,
//     subscribes to the customer's mic → continuous PCM → segmented here by
//     server-side VAD, and publishes the agent's translated speech back.
//
// Turns run through a SERIAL queue so overlapping speech never garbles
// playback. While the agent's translated speech is being injected into the
// room, the customer side is muted so the bot doesn't transcribe its own
// output as a new customer turn (feedback guard).

import { customerTurn, agentTurn, pcmToWav } from './pipeline-node.js';
import { getSession, addTranscript } from './session.js';
import { createPcmVad } from './vad.js';
import { joinRoomAsTranslator } from './livekit.js';

function sendToAgent(session, msg) {
  const ws = session.agentSocket;
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ─── Agent browser socket ─────────────────────────────────────────────────────
export function attachAgentSocket(session, ws) {
  session.agentSocket = ws;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  sendToAgent(session, { type: 'status', state: 'live', detail: 'Connected to translation relay' });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
    if (msg.type === 'agent-utterance' && msg.data) {
      const buffer = Buffer.from(msg.data, 'base64');
      enqueue(session, { kind: 'agent', audio: { buffer, mime: msg.mime || 'audio/webm' } });
    }
  });

  ws.on('close', () => { if (session.agentSocket === ws) session.agentSocket = null; });
  ws.on('error', () => {});
}

// ─── Customer side (LiveKit room) ──────────────────────────────────────────────
// Called when a session is registered. The relay joins the room, feeds the
// customer's PCM through the same VAD → turn queue, and stores an inject()
// handle for the agent → customer direction.
export async function startCustomerRoom(session) {
  const vad = createPcmVad({
    onUtterance: (pcm) => {
      if (session.customerMuted) return; // feedback guard during agent injection
      const wav = pcmToWav(pcm);
      enqueue(session, { kind: 'customer', audio: { buffer: wav, mime: 'audio/wav' } });
    },
  });

  try {
    session.livekit = await joinRoomAsTranslator({
      roomName: session.roomName,
      onCustomerPcm: (buf16k) => vad.push(buf16k),
      onStatus: (state) => sendToAgent(session, { type: 'status', state }),
    });
  } catch (e) {
    console.warn('[relay] LiveKit join failed:', e?.message);
    sendToAgent(session, { type: 'error', message: `Could not join room: ${e?.message}` });
  }
}

// ─── Serial turn queue ──────────────────────────────────────────────────────
function enqueue(session, turn) {
  session.queue.push(turn);
  pumpQueue(session);
}

async function pumpQueue(session) {
  if (session.processing) return;
  session.processing = true;
  try {
    while (session.queue.length) {
      const turn = session.queue.shift();
      try {
        if (turn.kind === 'customer') await runCustomerTurn(session, turn);
        else await runAgentTurn(session, turn);
      } catch (e) {
        console.warn(`[relay] ${turn.kind} turn failed:`, e?.message);
        sendToAgent(session, { type: 'error', message: `Translation failed: ${e?.message || 'unknown error'}` });
      }
    }
  } finally {
    session.processing = false;
  }
}

async function runCustomerTurn(session, turn) {
  const r = await customerTurn({
    audio: turn.audio,
    customerLang: session.customerLang,
    agentLang: session.agentLang,
    agentVoice: session.agentVoice,
  });
  if (!r) return;
  addTranscript(session, { who: 'customer', pivotEn: r.pivotEn, text: r.text });
  sendToAgent(session, { type: 'transcript', who: 'customer', pivotEn: r.pivotEn, text: r.text, ts: Date.now() });
  if (r.audioB64) {
    sendToAgent(session, { type: 'audio', who: 'customer', data: r.audioB64, format: r.audioFormat });
  }
}

async function runAgentTurn(session, turn) {
  const r = await agentTurn({
    audio: turn.audio,
    agentLang: session.agentLang,
    customerLang: session.customerLang,
    customerVoice: session.customerVoice,
  });
  if (!r) return;
  addTranscript(session, { who: 'agent', pivotEn: r.pivotEn, text: r.text });
  sendToAgent(session, { type: 'transcript', who: 'agent', pivotEn: r.pivotEn, text: r.text, ts: Date.now() });

  // Inject into the room; mute the customer side during + just after so the
  // relay doesn't pick up its own injected speech as a new customer turn.
  if (r.audioB64 && session.livekit) {
    session.customerMuted = true;
    try {
      const wav = Buffer.from(r.audioB64, 'base64'); // pcm16=true → Bulbul/Google both WAV
      await session.livekit.inject(wav);
    } catch (e) {
      console.warn('[relay] inject failed:', e?.message);
    }
    // Un-mute a touch after playback finishes. Rough estimate by text length;
    // inject() resolves when frames are queued, not when playback ends.
    const estMs = Math.min(15000, 800 + r.text.length * 55);
    setTimeout(() => { session.customerMuted = false; }, estMs);
  }
}
