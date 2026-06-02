// POST /api/bot/create — start a Meeting Bot session.
//   1) generate a room name + sessionId
//   2) mint a LiveKit token the CUSTOMER will use to join the room
//   3) register the session with the relay (which joins the room as the
//      server-side translator)
//   4) return { sessionId, roomName, customerUrl } to the agent's browser
//
// The agent does NOT join the LiveKit room — they talk to the relay over our
// own WebSocket (see src/api/bot.js). Only the customer is in the room.
import { randomUUID } from 'crypto';
import { AccessToken } from 'livekit-server-sdk';
import { withAuth, logUsage } from '../_auth.js';

const LIVEKIT_URL        = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
// Read the same var the client uses (VITE_ vars are still plain env vars on the
// server). One relay URL var total. BOT_RELAY_HTTP_URL kept as an optional override.
const RELAY_HTTP_URL = process.env.BOT_RELAY_HTTP_URL || process.env.VITE_BOT_RELAY_HTTP_URL;
const RELAY_SECRET   = process.env.RELAY_SHARED_SECRET || '';
const WEBAPP_URL     = process.env.WEBAPP_URL || 'https://vaak-setu.vercel.app';

export default withAuth(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { agentLang, customerLang, agentVoice = 'male', customerVoice = 'female' } = req.body || {};
  if (!agentLang || !customerLang) return res.status(400).json({ error: 'agentLang and customerLang required' });
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
    return res.status(500).json({ error: 'LIVEKIT_* not configured' });
  }
  if (!RELAY_HTTP_URL) return res.status(500).json({ error: 'BOT_RELAY_HTTP_URL not configured' });

  const sessionId = randomUUID();
  const roomName  = `vaaksetu-${sessionId.slice(0, 8)}`;

  // Customer token — limited to this room, 2h TTL.
  let customerToken;
  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: `customer-${sessionId.slice(0, 6)}`,
      name: 'Customer',
      ttl: 7200,
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
    customerToken = await at.toJwt();
  } catch (e) {
    return res.status(500).json({ error: `token mint failed: ${e?.message}` });
  }

  // Register the session with the relay → it joins the room as translator.
  try {
    const regRes = await fetch(`${RELAY_HTTP_URL}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-secret': RELAY_SECRET },
      body: JSON.stringify({
        sessionId, roomName,
        orgId:  req.auth?.profile?.org_id || null,
        userId: req.auth?.user?.id || null,
        agentLang, customerLang, agentVoice, customerVoice,
      }),
    });
    if (!regRes.ok) return res.status(502).json({ error: `relay register failed (${regRes.status})` });
  } catch (e) {
    return res.status(502).json({ error: `relay unreachable: ${e?.message}` });
  }

  // Shareable link the agent sends to the customer (WhatsApp/email/etc).
  const customerUrl = `${WEBAPP_URL}/room.html?url=${encodeURIComponent(LIVEKIT_URL)}&token=${encodeURIComponent(customerToken)}`;

  logUsage(req.auth, {
    event_type: 'bot_create', provider: 'livekit',
    source_lang: customerLang, target_lang: agentLang,
    metadata: { sessionId, roomName },
  });

  res.status(200).json({ sessionId, roomName, customerUrl });
});
