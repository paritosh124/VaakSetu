// POST /api/bot/stop — end a Meeting Bot session. Tells the relay to leave the
// LiveKit room and persist the transcript to bot_sessions.
import { withAuth, logUsage } from '../_auth.js';

const RELAY_HTTP_URL = process.env.BOT_RELAY_HTTP_URL || process.env.VITE_BOT_RELAY_HTTP_URL;
const RELAY_SECRET   = process.env.RELAY_SHARED_SECRET || '';

export default withAuth(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { sessionId } = req.body || {};
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  if (RELAY_HTTP_URL) {
    try {
      await fetch(`${RELAY_HTTP_URL}/sessions/${sessionId}/end`, {
        method: 'POST',
        headers: { 'x-relay-secret': RELAY_SECRET },
      });
    } catch (e) {
      console.warn('[bot/stop] relay teardown failed:', e?.message);
    }
  }

  logUsage(req.auth, { event_type: 'bot_stop', provider: 'livekit', metadata: { sessionId } });
  res.status(200).json({ ok: true });
});
