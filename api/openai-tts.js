// OpenAI TTS proxy — returns raw mp3 binary
import { withAuth, logUsage, estimateCost } from './_auth.js';

export default withAuth(async function handler(req, res) {
  const response = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return res.status(response.status).json(data);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.setHeader('Content-Type', 'audio/mpeg');
  res.status(200).send(buffer);

  const chars = (req.body?.input || '').length;
  logUsage(req.auth, {
    event_type: 'tts',
    provider:   'openai',
    chars,
    api_cost_cents: estimateCost('openai_tts', { chars }),
  });
});
