# CLAUDE.md — Project Context for VaakSetu

## What is VaakSetu?
VaakSetu (वाक् + सेतु = Voice Bridge) is a bidirectional real-time voice translator for Indian languages. Two people who don't speak each other's language share one device, take turns pressing hold-to-talk buttons, and hear translations spoken aloud.

**Live:** https://vaak-setu.vercel.app

## Tech Stack
- **Frontend:** React + Vite (single-page app)
- **APIs:** Sarvam AI (all three models below)
- **Hosting:** Vercel (Mumbai region `bom1`) with serverless functions proxying Sarvam API
- **Domain (planned):** vaaksetu.ai

## Sarvam AI Models Used
- **Saaras v3** (`saaras:v3`) — Speech-to-Text via `/speech-to-text`
- **Mayura** (`mayura:v1`) — Translation via `/translate`
- **Bulbul v3** (`bulbul:v3`) — Text-to-Speech via `/text-to-speech`

## Architecture — English Pivot Strategy
Mayura only supports English ↔ Indian language (not Indian ↔ Indian directly).
So ALL translations route through English as a pivot:

```
Indian lang speech → Saaras (mode="translate") → English text → Mayura (en → target) → Bulbul TTS
English speech     → Saaras (mode="transcribe") → English text → Mayura (en → target) → Bulbul TTS
Any → English      → Saaras (mode="translate")  → English text → Bulbul TTS (skip Mayura)
```

This means:
- Hindi→Telugu: 3 API calls (STT+translate, Mayura, TTS)
- Telugu→English: 2 API calls (STT+translate, TTS) — fastest path
- English→Telugu: 3 API calls (STT, Mayura, TTS)

## Supported Languages (all 11 Sarvam languages)
Hindi, English, Bengali, Gujarati, Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil, Telugu.

Person A and Person B each have **independent language dropdowns**, so any combination works (e.g. Marathi ↔ Tamil). Default is Hindi ↔ Telugu.

## Project Structure
```
src/
  App.jsx               — Main UI (selectors, conversation feed, hold-to-talk buttons)
  pipeline.js           — Orchestrates STT → Translate → TTS pipeline (emits text early, audio async)
  api/sarvam.js         — Wrapper for Sarvam API calls + AudioContext playback
  main.jsx              — React entry point
api/
  speech-to-text.js     — Vercel serverless proxy (multipart passthrough)
  translate.js          — Vercel serverless proxy (JSON)
  text-to-speech.js     — Vercel serverless proxy (JSON)
index.html              — HTML entry with fonts (Crimson Pro + DM Sans)
vite.config.js          — Dev proxy (/sarvam → api.sarvam.ai) + basicSsl for HTTPS on LAN
vercel.json             — Region bom1 (Mumbai) + framework Vite
.npmrc                  — legacy-peer-deps=true (for @vitejs/plugin-basic-ssl vs Vite 5 peer conflict)
.env                    — VITE_SARVAM_API_KEY (local dev only, not committed)
```

## API Configuration

### Dev
- Vite proxies `/sarvam/*` → `https://api.sarvam.ai/*` (avoids CORS)
- API key is read from `.env` (`VITE_SARVAM_API_KEY`) or from localStorage (via setup screen)
- API key is sent as `api-subscription-key` header from the browser

### Production (Vercel)
- **No browser-side API key.** Setup screen is hidden; users never enter a key
- Frontend calls `/api/speech-to-text`, `/api/translate`, `/api/text-to-speech`
- Serverless functions inject `SARVAM_API_KEY` from Vercel env vars and forward to `https://api.sarvam.ai`
- Functions deployed in `bom1` (Mumbai) region for minimum latency to Sarvam

## Voices (Bulbul v3)

- Two voice options exposed in UI: **Male** → `anand`, **Female** → `ritu`
- Available Sarvam speakers (lowercase required): anushka, abhilash, manisha, vidya, arya, karun, hitesh, aditya, ritu, priya, neha, rahul, pooja, rohan, simran, kavya, amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa, kabir, aayan, shubh, ashutosh, advait, anand, tanya, tarun, sunny, mani, gokul, vijay, shruti, suhani, mohit, kavitha, rehan, soham, rupali

### Voice UX model — **Listener's preference**
Each person's voice toggle = the voice they want to *hear* translations in. When Person A speaks, Person B is hearing the output, so Person B's voice preference is used. This avoids the confusion where a speaker sets their own voice but never hears it themselves.

Defaults: Person A → male, Person B → female. Preferences persist via localStorage (`vs_langA`, `vs_langB`, `vs_voiceA`, `vs_voiceB`).

## Audio Recording & Playback (browser gotchas)

### Recording — MediaRecorder
- MIME type chosen dynamically: `audio/mp4` preferred (iOS), falls back to `audio/webm` (Chrome/Android)
- `MediaRecorder.isTypeSupported()` gates selection
- When constructing the Blob, strip the `;codecs=...` suffix from `mediaRecorder.mimeType` — Sarvam rejects `audio/mp4;codecs=opus` but accepts `audio/mp4`
- Filename extension in the form part matches the Blob MIME (e.g. `audio.m4a` for mp4, `audio.webm` for webm)
- `getUserMedia` must be called **synchronously within the user gesture** for iOS Safari — never `await` before it
- Minimum blob size check (1000 bytes) to reject accidental taps

### Playback — AudioContext (iOS Safari autoplay)
- iOS Safari blocks `new Audio(...).play()` unless triggered directly by a user gesture
- Fix: module-level `AudioContext` created and `resume()`d inside `unlockAudio()`, called synchronously on every button press
- `playBase64Audio` then uses `ctx.decodeAudioData` + `ctx.createBufferSource()` instead of `<audio>` element
- The TTS base64 is raw WAV; decode it into an `AudioBuffer` and play through the already-unlocked context

## UI Design
- Dark theme: deep indigo (#0C0B1A) background
- Person A accent: amber (#F5A623)
- Person B accent: teal (#0FB8A9)
- Fonts: Crimson Pro (headers), DM Sans (body)
- Top bar: logo + (optional) gear icon (dev only)
- Selector row: Person A (lang + voice toggle) ↔ Person B (lang + voice toggle)
- Hold-to-talk buttons with pulse ring animation while recording

## Features Implemented
- [x] Hold-to-talk recording (Person A / Person B)
- [x] Full STT → Translate → TTS pipeline
- [x] Independent language selectors for Person A and Person B (all 11 Sarvam languages)
- [x] Male / Female voice toggle per person (listener's preference model)
- [x] Preferences persist in localStorage
- [x] Conversation feed with message bubbles
- [x] English pivot text shown as secondary transcript
- [x] Auto-scroll to latest message
- [x] API key setup screen with localStorage persistence (dev only — hidden in prod)
- [x] Error handling and display (with specific iOS-mic guidance)
- [x] Replay button on each message bubble (plays stored TTS audio via unlocked AudioContext)
- [x] Processing status indicator with step icons
- [x] Vercel production deployment with serverless API proxy
- [x] Server-side API key (no browser exposure in production)
- [x] Audio format compatibility for iOS Safari (mp4) and Chrome (webm)

## Latency Optimizations

Target: keep perceived latency under ~2s.

Applied:
- **Vercel region `bom1` (Mumbai)** — closest to Sarvam's India-based API, saves ~600-900ms round-trip vs US East
- **Show text immediately** — pipeline emits translated text via `onText` callback as soon as Mayura responds; message bubble and "Ready" state render before TTS completes. Audio is attached to the bubble later when TTS returns
- **Pre-warm TCP connection** — on button press (user gesture), a `fetch('/api/speech-to-text', { method: 'HEAD' })` opens a TLS connection before the user finishes speaking

Pending:
- [ ] Downsample audio to 16kHz mono before upload (~60% smaller payload)
- [ ] Cache TTS audio for common short phrases
- [ ] Stream TTS playback (blocked by Sarvam — no streaming API today)
- [ ] Speculative Mayura call while STT still in flight (blocked by pipeline dependency)

## Planned Enhancements
- [ ] Register `vaaksetu.ai` domain and point to Vercel
- [ ] iOS app via Expo / React Native (to improve UX and avoid Safari permission quirks)
- [ ] Auto-detect source language
- [ ] Live waveform visualizer during recording
- [ ] Clear conversation / reset button
- [ ] Copy transcript text
- [ ] Latency timer per message
- [ ] Light/dark mode toggle
- [ ] Mute TTS (text-only mode)
- [ ] Offline fallback for common phrases

## Deployment

### Vercel
```bash
vercel              # first-time: creates project
vercel env add SARVAM_API_KEY production   # set server-side API key
vercel --prod       # deploy to production
```

`.npmrc` ensures Vercel's `npm install` works despite Vite 5 vs `@vitejs/plugin-basic-ssl` peer conflict.

### Local dev
```bash
npm run dev                 # localhost:5173
npm run dev -- --host       # exposes on LAN (uses self-signed cert via basicSsl plugin)
npm run build               # production build → dist/
```

To test on phone via LAN: `npm run dev -- --host`, open `https://<your-ip>:5173`, accept the self-signed-cert warning. Microphone requires HTTPS on iOS Safari.

## Business Context

- **Insight:** Indian language translation is underserved by big tech; Sarvam models significantly outperform Google Translate for Indian languages
- **Moat thinking:** A thin wrapper over Sarvam is not defensible. Real moat comes from either (a) a vertical SaaS play (hospitals/banks/courts), (b) a hardware device (pocket translator / badge / counter unit), or (c) domain-specific fine-tuning using proprietary conversation data
- **Current phase:** MVP web app as a validation tool before committing to iOS/hardware
- **Recommended next step:** validate with 5-10 paying customers in one vertical (healthcare or banking field agents are strongest bets) before deeper investment

## Session History & Decisions (notable)

- Switched from fixed language *pairs* to independent Person A / Person B language dropdowns for flexibility across all Sarvam languages
- Chose **listener's voice preference** model over speaker's identity — user reported confusion because a speaker never hears their own voice play
- Serverless API proxy in production means users don't supply their own Sarvam key (all translations billed to project owner's Sarvam account)
- `@vitejs/plugin-basic-ssl` was added for LAN phone testing with HTTPS, but creates Vite 5 peer-dep conflict → handled with `.npmrc legacy-peer-deps=true`
- iOS Safari debugging rabbit hole: mic permission → audio format → AudioContext autoplay policy (all resolved)

## Commands
```bash
npm run dev               # dev server (localhost:5173)
npm run dev -- --host     # expose on LAN (HTTPS via self-signed cert)
npm run build             # production build
vercel --prod             # deploy to production
```
