/**
 * peer.js — Thin wrapper around PeerJS for room-based WebRTC data channel
 *
 * Messages over the data channel are JSON:
 *   { type: 'hello',   lang: 'hi-IN' }           — sent once on connect, both sides exchange
 *   { type: 'english', text: '...', ts: 12345 }  — an utterance (English pivot) from the partner
 *
 * Host creates a room and gets a code. Guest joins with that code.
 * The room code IS the host's PeerJS id (short, memorable).
 */

import { Peer } from 'peerjs';

// 4-letter codes using consonants/vowels unlikely to form profanity
const ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ'; // skip A/E/I/O/U/L to reduce word formation

export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return code;
}

export function createHostPeer(roomCode) {
  // PeerJS prefix so room codes don't collide with random peers on the public signaling server
  return new Peer(`vaaksetu-${roomCode}`, { debug: 1 });
}

export function createGuestPeer() {
  return new Peer(undefined, { debug: 1 });
}

export function hostPeerId(roomCode) {
  return `vaaksetu-${roomCode}`;
}
