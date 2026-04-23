// Whisper translation proxy — speech in any language → English text
import { handlePreflight } from './_cors.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const response = await fetch('https://api.openai.com/v1/audio/translations', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'content-type': req.headers['content-type'],
    },
    body,
  });

  const data = await response.json();
  res.status(response.status).json(data);
}
