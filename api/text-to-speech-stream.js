// Streaming Bulbul TTS proxy.
// Forwards POST body to Sarvam's `/text-to-speech/stream` and pipes the raw
// audio response back to the client without buffering. Audio starts playing
// on the client within ~200-400ms of the request rather than waiting for
// full generation (~1-3s with the batch endpoint).
//
// Usage on Vercel: returns a streamed response. The Node.js runtime handles
// `res.write()` chunks correctly without buffering.
import { withAuth, logUsage, estimateCost } from './_auth.js';

export const config = { api: { bodyParser: true } };

export default withAuth(async function handler(req, res) {
  const t0 = Date.now();
  const body = req.body || {};

  let upstream;
  try {
    upstream = await fetch('https://api.sarvam.ai/text-to-speech/stream', {
      method: 'POST',
      headers: {
        'api-subscription-key': process.env.SARVAM_API_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    res.status(502).json({ error: `Upstream fetch failed: ${err.message}` });
    return;
  }

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    res.status(upstream.status).send(errBody);
    return;
  }

  // Mirror the upstream content-type so the browser knows what to decode
  // (typically audio/mpeg for Bulbul streaming).
  const ct = upstream.headers.get('content-type') || 'audio/mpeg';
  res.setHeader('Content-Type', ct);
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('Transfer-Encoding', 'chunked');

  // Pipe the upstream body into the response. Node 18+ on Vercel exposes
  // `upstream.body` as a Web ReadableStream — we read chunks and write them.
  const reader = upstream.body.getReader();
  let totalBytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      res.write(Buffer.from(value));
    }
  } catch (err) {
    console.error('[tts-stream] pipe error', err?.message);
  } finally {
    res.end();
  }

  const chars = (body?.text || body?.inputs?.[0] || '').length;
  logUsage(req.auth, {
    event_type:  'tts',
    provider:    'sarvam',
    target_lang: body?.target_language_code || null,
    chars,
    duration_ms: Date.now() - t0,
    api_cost_cents: estimateCost('sarvam_tts', { chars }),
    metadata: { streaming: true, bytes: totalBytes },
  });
});
