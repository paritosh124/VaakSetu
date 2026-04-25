import { withAuth, logUsage, estimateCost } from './_auth.js';

export default withAuth(async function handler(req, res) {
  const response = await fetch('https://api.sarvam.ai/text-to-speech', {
    method: 'POST',
    headers: {
      'api-subscription-key': process.env.SARVAM_API_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify(req.body),
  });

  const data = await response.json();
  res.status(response.status).json(data);

  if (response.ok) {
    const chars = (req.body?.inputs?.[0] || req.body?.text || '').length;
    logUsage(req.auth, {
      event_type:  'tts',
      provider:    'sarvam',
      target_lang: req.body?.target_language_code || null,
      chars,
      api_cost_cents: estimateCost('sarvam_tts', { chars }),
    });
  }
});
