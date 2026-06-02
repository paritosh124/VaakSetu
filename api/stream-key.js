// Returns the Sarvam API key for WebSocket streaming.
// The key is intentionally public (same trade-off as VITE_SARVAM_API_KEY baked
// into the JS bundle). This endpoint lets the webapp fetch it at runtime when
// the build-time env var isn't set.
import { handlePreflight } from './_cors.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const key = process.env.SARVAM_API_KEY || '';
  if (!key) return res.status(500).json({ error: 'SARVAM_API_KEY not configured' });
  res.status(200).json({ key });
}
