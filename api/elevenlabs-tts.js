// ElevenLabs TTS proxy — returns raw mp3 binary
import { handlePreflight } from './_cors.js';

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  // voice_id is passed as the last path segment: /api/elevenlabs-tts/VOICE_ID
  const voiceId = req.query.voiceId || req.url.split('/').pop();

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': process.env.ELEVENLABS_API_KEY,
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
