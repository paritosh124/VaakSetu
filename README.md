# VaakSetu — Bidirectional Voice Translator

**वाक् + सेतु = Voice Bridge**

Real-time bidirectional voice translation for Indian languages. Two people who speak different languages share one device, take turns holding a button to speak, and hear the translation spoken aloud.

**Live app:** [https://vaak-setu.vercel.app](https://vaak-setu.vercel.app)

---

## Supported Languages

| Pair | Direction |
|------|-----------|
| Hindi ↔ Telugu | Bidirectional |
| Hindi ↔ Gujarati | Bidirectional |
| Hindi ↔ Punjabi | Bidirectional |
| Hindi ↔ Kannada | Bidirectional |
| Hindi ↔ Marathi | Bidirectional |
| Hindi ↔ Tamil | Bidirectional |
| Hindi ↔ Bengali | Bidirectional |
| Hindi ↔ Malayalam | Bidirectional |
| English ↔ Telugu | Bidirectional |

---

## How to Use

1. Open [https://vaak-setu.vercel.app](https://vaak-setu.vercel.app) on any device
2. Select the language pair from the dropdown (e.g. Hindi ↔ Tamil)
3. **Person A** holds their button and speaks in their language, then releases
4. The translation plays aloud in the other person's language
5. **Person B** does the same in their language
6. Tap **Replay** on any message bubble to hear the translation again

> Works on desktop and Android Chrome. iOS Safari requires microphone permission enabled under Settings → Privacy & Security → Microphone → Safari.

---

## How It Works

All translations route through English as a pivot language (Sarvam's Mayura model only supports English ↔ Indian language pairs):

```
Indian language speech → Saaras v3 (STT + translate to English)
                       → Mayura (English → target language)
                       → Bulbul v3 (Text to Speech)
                       → Plays audio
```

**Typical latency:** 2–3 seconds end-to-end.

---

## Tech Stack

- **React + Vite** — frontend
- **Vercel** — hosting + serverless API proxy
- **Sarvam AI** — all three models:
  - `saaras:v3` — Speech to Text
  - `mayura:v1` — Translation
  - `bulbul:v3` — Text to Speech

---

## Local Development

```bash
# 1. Clone and install
git clone https://github.com/your-username/VaakSetu.git
cd VaakSetu
npm install

# 2. Add your Sarvam API key
echo "VITE_SARVAM_API_KEY=your_key_here" > .env

# 3. Start dev server
npm run dev
# Open http://localhost:5173
```

Get a Sarvam API key at [dashboard.sarvam.ai](https://dashboard.sarvam.ai).

---

## Deploying Your Own Instance

```bash
npm install -g vercel
vercel login
vercel --prod

# Set your API key as a server-side environment variable
vercel env add SARVAM_API_KEY production
vercel --prod
```

---

## Roadmap

- [ ] iOS app (React Native / Expo)
- [ ] More language pairs (Odia, Assamese, Sindhi)
- [ ] Auto language detection
- [ ] Waveform visualiser during recording
- [ ] Offline fallback for common phrases
- [ ] Copy transcript button
- [ ] Latency timer per message
