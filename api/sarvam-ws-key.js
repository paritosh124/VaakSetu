// Returns the Sarvam key for the WebSocket streaming URL.
// The extension has no build-time env injection (no Vite), so it fetches the
// key at runtime. Same trade-off as the webapp's VITE_SARVAM_API_KEY — the
// key is observable by any caller, so we at minimum gate it behind login so
// only signed-in VaakSetu users can pick it up.
import { withAuth } from './_auth.js';

export default withAuth(async function handler(req, res) {
  const key = process.env.SARVAM_API_KEY || '';
  if (!key) return res.status(500).json({ error: 'SARVAM_API_KEY not configured' });
  res.status(200).json({ key });
});
