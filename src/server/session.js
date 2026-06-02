// session.js — in-memory registry of active Meeting Bot sessions.
// A session ties together: the Recall bot, the agent's browser socket, the
// (optional) Recall audio socket, language/voice config, and a serial turn
// queue. Durable records go to Supabase (see supabase.js); this is ephemeral
// state for the lifetime of one call.

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from './config.js';

const sessions = new Map(); // sessionId → Session

const supa = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export function createSession(sessionId, cfg) {
  const session = {
    sessionId,
    roomName:     cfg.roomName || null,
    orgId:        cfg.orgId || null,
    userId:       cfg.userId || null,
    agentLang:    cfg.agentLang,
    customerLang: cfg.customerLang,
    agentVoice:   cfg.agentVoice || 'male',
    customerVoice: cfg.customerVoice || 'female',
    agentSocket:  null,   // browser WS (agent side)
    livekit:      null,   // { inject, disconnect } — set once the relay joins the room
    customerMuted: false, // feedback guard during agent-audio injection
    queue:        [],     // pending turns
    processing:   false,  // serial lock
    transcript:   [],     // [{ who, pivotEn, text, ts }]
    createdAt:    Date.now(),
  };
  sessions.set(sessionId, session);
  return session;
}

export const getSession = (id) => sessions.get(id);

export function endSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  try { s.agentSocket?.close(); } catch {}
  try { s.livekit?.disconnect(); } catch {}
  persistSession(s).catch((e) => console.warn('[session] persist failed:', e?.message));
  sessions.delete(id);
}

export function addTranscript(session, entry) {
  session.transcript.push({ ts: Date.now(), ...entry });
}

// Write the final bot_sessions row on teardown. Fire-and-forget; logging must
// never break a call.
async function persistSession(s) {
  if (!supa || !s.orgId) return;
  const ended = Date.now();
  await supa.from('bot_sessions').insert({
    org_id:         s.orgId,
    room_name:      s.roomName,
    source_lang:    s.customerLang,
    target_lang:    s.agentLang,
    started_at:     new Date(s.createdAt).toISOString(),
    ended_at:       new Date(ended).toISOString(),
    duration_seconds: Math.round((ended - s.createdAt) / 1000),
    transcript:     s.transcript,
  });
}

export function activeSessionCount() {
  return sessions.size;
}
