# 🌐 VaakSetu — Bidirectional Voice Translator

**Speech → Translation → Speech** for Indian languages, powered by [Sarvam AI](https://sarvam.ai).

## Supported Language Pairs (MVP)
| Pair | Direction |
|------|-----------|
| Hindi ↔ Telugu | Bidirectional |
| English ↔ Telugu | Bidirectional |

---

## ⚡ Quick Start (Local Dev)

```bash
# 1. Install dependencies
npm install

# 2. Add your Sarvam API key
cp .env.example .env
# → Edit .env and paste your key: VITE_SARVAM_API_KEY=sk_...

# 3. Run
npm run dev
# Open http://localhost:5173
```

**Note:** During `npm run dev`, the Vite proxy routes all `/sarvam/*` requests to `https://api.sarvam.ai` — this avoids CORS issues in development.

---

## 🚀 Deploy to Vercel

```bash
npm run build
# Push to GitHub, then import repo in Vercel dashboard
# Add VITE_SARVAM_API_KEY as an Environment Variable in Vercel
```

> ⚠️ **CORS on Vercel:** In production, the Vite proxy is gone. If Sarvam's API doesn't send CORS headers for browser requests, you'll need to add a thin Vercel API proxy — see below.

### Optional: Vercel API Proxy (if CORS errors occur in prod)

Create `/api/sarvam.js` in the project root:

```js
// api/sarvam.js — Vercel serverless proxy
export default async function handler(req, res) {
  const path = req.query.path || '';
  const url = `https://api.sarvam.ai/${path}`;
  const upstream = await fetch(url, {
    method: req.method,
    headers: {
      'api-subscription-key': process.env.SARVAM_API_KEY, // server-side, not exposed
      ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
    },
    body: req.method !== 'GET' ? req : undefined,
  });
  const data = await upstream.arrayBuffer();
  res.status(upstream.status).send(Buffer.from(data));
}
```

Then in `src/api/sarvam.js`, change:
```js
// From:
const BASE = import.meta.env.DEV ? '/sarvam' : 'https://api.sarvam.ai';
// To:
const BASE = import.meta.env.DEV ? '/sarvam' : '/api/sarvam?path=';
```

---

## 🧠 How It Works

```
[Hold Button → Speak → Release]
        ↓
Saaras v3 (mode=translate)    → English text   [STT, ~900ms]
        ↓
Mayura  (en-IN → target lang) → Translated text [~300ms, skipped for en↔te one direction]
        ↓
Bulbul v3                     → Audio (base64) [TTS, ~600ms]
        ↓
[Plays audio]
```

**Latency target:** ~1.5–2.5 seconds end-to-end.

**English pivot strategy:** Saaras `mode=translate` converts any Indian language speech directly to English in one API call. This means we never need direct Indian↔Indian translation (Mayura doesn't support it anyway).

---

## 🔑 API Key Security

- For local dev: key is in `.env` (never committed to git)
- For Vercel prod: key is in Vercel Environment Variables (server-side)
- The Setup screen in the app also stores the key in `localStorage` as a convenience — this is fine for personal/demo use

---

## 📦 Tech Stack
- **React + Vite** — fast dev server, easy Vercel deploy
- **MediaRecorder API** — browser-native audio recording
- **Sarvam AI** — Saaras v3 (STT), Mayura (Translate), Bulbul v3 (TTS)

---

## 🗺️ Roadmap
- [ ] Add more language pairs (Kannada, Malayalam, Marathi…)
- [ ] Waveform visualiser during recording
- [ ] Copy transcript button
- [ ] Dark/light mode toggle
- [ ] Offline fallback for common phrases (cached TTS)
