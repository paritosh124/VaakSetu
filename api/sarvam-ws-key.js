// Returns the Sarvam key for the WebSocket streaming URL.
// The extension has no build-time env injection (no Vite), so it fetches the
// key at runtime. Same trade-off as the webapp's VITE_SARVAM_API_KEY — the
// key is observable by any caller of this endpoint, but that matches what
// ends up in the browser JS bundle for the webapp.
import { handlePreflight } from './_cors.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const key = process.env.SARVAM_API_KEY || '';
  if (!key) return res.status(500).json({ error: 'SARVAM_API_KEY not configured' });
  res.status(200).json({ key });
}
