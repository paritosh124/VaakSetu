import { withAuth, logUsage, estimateCost } from './_auth.js';

export default withAuth(async function handler(req, res) {
  const response = await fetch('https://api.sarvam.ai/translate', {
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
    const chars = (req.body?.input || '').length;
    logUsage(req.auth, {
      event_type:  'translate',
      provider:    'sarvam',
      source_lang: req.body?.source_language_code || null,
      target_lang: req.body?.target_language_code || null,
      chars,
      api_cost_cents: estimateCost('sarvam_translate', { chars }),
    });
  }
});
