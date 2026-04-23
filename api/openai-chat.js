// GPT-4o-mini translation proxy
import { handlePreflight } from './_cors.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
  });

  const data = await response.json();
  res.status(response.status).json(data);
}
