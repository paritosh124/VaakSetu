// OpenAI TTS proxy — returns raw mp3 binary
import { handlePreflight } from './_cors.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
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
}
