// Google Cloud TTS proxy — free tier: 4M chars/month (Standard voices)
// Returns { audioContent: base64_mp3 }
import { withAuth, logUsage } from './_auth.js';

// Maps our internal codes (ISO-639-1 or BCP-47) to Google TTS language codes
const LANG_MAP = {
  es: 'es-ES', fr: 'fr-FR', de: 'de-DE', ja: 'ja-JP',
  zh: 'zh-CN', ar: 'ar-XA', pt: 'pt-BR', ru: 'ru-RU',
  it: 'it-IT', ko: 'ko-KR', nl: 'nl-NL', tr: 'tr-TR',
  pl: 'pl-PL', sv: 'sv-SE', th: 'th-TH', vi: 'vi-VN',
  id: 'id-ID', uk: 'uk-UA', en: 'en-US', 'en-IN': 'en-IN',
};

export default withAuth(async function handler(req, res) {
  const { text, languageCode, voiceGender } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });

  const gcpLang = LANG_MAP[languageCode] || LANG_MAP[languageCode?.split('-')[0]] || 'en-US';
  const ssmlGender = voiceGender === 'female' ? 'FEMALE' : 'MALE';

  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: gcpLang, ssmlGender },
        audioConfig: { audioEncoding: 'MP3' },
      }),
    }
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    return res.status(response.status).json(data);
  }

  const data = await response.json();
  res.status(200).json({ audioContent: data.audioContent });

  logUsage(req.auth, {
    event_type: 'tts',
    provider: 'google',
    chars: text.length,
    api_cost_cents: 0, // within free tier (4M chars/month for Standard voices)
  });
});
