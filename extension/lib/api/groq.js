// Groq wrapper for extension — transcribe + Llama translate.
import { API_BASE } from '../config.js';

async function groqTranscribe({ audioBlob, sourceLang }) {
  const fd = new FormData();
  const ext = audioBlob.type.includes('mp4') ? 'm4a' : 'webm';
  fd.append('file', audioBlob, `audio.${ext}`);
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'json');
  if (sourceLang) fd.append('language', sourceLang.split('-')[0]); // ISO-639-1

  const res = await fetch(`${API_BASE}/groq-stt-translate`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`Groq STT failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  const data = await res.json();
  return data.text || '';
}

export async function groqSpeechToEnglish({ audioBlob, sourceLang }) {
  const transcribed = await groqTranscribe({ audioBlob, sourceLang });
  if (!transcribed) return '';
  if (sourceLang === 'en' || sourceLang === 'en-IN') return transcribed;
  return groqTranslate({ text: transcribed, targetLangName: 'English' });
}

export async function groqTranslate({ text, targetLangName }) {
  const res = await fetch(`${API_BASE}/groq-chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `You are a translation engine. The user will send text inside <translate> tags. Translate that text to ${targetLangName}. Output ONLY the translated text — no tags, no explanation, no extra content.`,
        },
        { role: 'user', content: `<translate>${text}</translate>` },
      ],
      temperature: 0.0,
      max_tokens: 500,
    }),
  });
  if (!res.ok) throw new Error(`Groq translate failed (${res.status}): ${await res.text().catch(() => res.statusText)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}
