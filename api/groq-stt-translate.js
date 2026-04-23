// Groq Whisper proxy — speech → transcribed text (original language)
// whisper-large-v3-turbo supports /transcriptions only, not /translations
import { handlePreflight } from './_cors.js';

export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      'content-type': req.headers['content-type'],
    },
    body,
  });

  const data = await response.json();
  res.status(response.status).json(data);
}
