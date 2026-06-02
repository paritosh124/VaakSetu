// index.js — relay bootstrap. Express for HTTP control + health, `ws` for the
// long-lived audio/transcript sockets. Deployed standalone (Render free tier
// for POC). Vercel functions can't host this — they time out in seconds.

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { PORT } from './config.js';
import { createSession, getSession, endSession, activeSessionCount } from './session.js';
import { attachAgentSocket, startCustomerRoom } from './bot-relay.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Health / wake endpoint ───────────────────────────────────────────────────
// The client hits this FIRST (see §2.1 of MEETING_BOT_PLAN.md) to wake the
// free-tier instance from cold start before creating a bot / opening sockets.
app.get('/health', (_req, res) => {
  res.json({ ok: true, activeSessions: activeSessionCount(), ts: Date.now() });
});

// ─── Session registration ─────────────────────────────────────────────────────
// Called by the Vercel control plane (api/bot/create.js) right after it creates
// the Recall bot, so the relay knows the language config before sockets connect.
// Protected by a shared secret so randoms can't register sessions.
app.post('/sessions', (req, res) => {
  const secret = req.headers['x-relay-secret'];
  if (process.env.RELAY_SHARED_SECRET && secret !== process.env.RELAY_SHARED_SECRET) {
    return res.status(401).json({ error: 'bad relay secret' });
  }
  const { sessionId, ...cfg } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
  const session = createSession(sessionId, cfg);
  res.json({ ok: true });
  // Join the LiveKit room in the background so the relay is in the room before
  // the customer arrives. Errors are surfaced to the agent over the WS.
  startCustomerRoom(session).catch((e) => console.warn('[relay] startCustomerRoom:', e?.message));
});

app.post('/sessions/:id/end', (req, res) => {
  endSession(req.params.id);
  res.json({ ok: true });
});

const server = createServer(app);

// ─── WebSocket routing by path ────────────────────────────────────────────────
//   /agent?sessionId=…   browser agent socket (the customer joins via LiveKit,
//                        not our WS — see livekit.js)
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const sessionId = url.searchParams.get('sessionId');
  const session = sessionId && getSession(sessionId);
  if (!session || url.pathname !== '/agent') { socket.destroy(); return; }

  wss.handleUpgrade(req, socket, head, (ws) => {
    attachAgentSocket(session, ws);
  });
});

// ─── Keep-alive ping ───────────────────────────────────────────────────────────
// Defeats the free-tier 15-min idle spin-down during a live-but-quiet call, and
// reaps dead agent sockets.
const KEEPALIVE_MS = 25000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, KEEPALIVE_MS);

server.listen(PORT, () => {
  console.log(`[vaaksetu-relay] listening on :${PORT}`);
});
