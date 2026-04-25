// Groq Llama translation proxy
import { withAuth, logUsage, estimateCost } from './_auth.js';

export default withAuth(async function handler(req, res) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
  });

  const data = await response.json();
  res.status(response.status).json(data);

  if (response.ok) {
    const prompt  = (req.body?.messages || []).map((m) => m?.content || '').join('');
    const chars = prompt.length + (data?.choices?.[0]?.message?.content || '').length;
    logUsage(req.auth, {
      event_type: 'translate',
      provider:   'groq',
      chars,
      api_cost_cents: estimateCost('groq_chat', { chars }),
    });
  }
});
