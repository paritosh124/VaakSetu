// Whisper transcription proxy — forwards multipart audio to OpenAI
import { withAuth, logUsage, estimateCost } from './_auth.js';

export const config = { api: { bodyParser: false } };

export default withAuth(async function handler(req, res) {
  const t0 = Date.now();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': req.headers['content-type'],
    },
    body,
  });

  const data = await response.json();
  res.status(response.status).json(data);

  if (response.ok) {
    const duration_ms = Date.now() - t0;
    const chars = (data?.text || '').length;
    logUsage(req.auth, {
      event_type: 'stt',
      provider:   'openai',
      chars, duration_ms,
      api_cost_cents: estimateCost('openai_stt', { duration_ms }),
    });
  }
});
