# CLAUDE.md — Project Context for VaakSetu

## What is VaakSetu?
VaakSetu (वाक् + सेतु = Voice Bridge) is a bidirectional real-time voice translator supporting Indian and international languages. Two people who don't speak each other's language can either share one device (two hold-to-talk buttons) or use separate phones connected via WebRTC (two-phone remote mode).

**Live:** https://vaak-setu.vercel.app

## Tech Stack
- **Frontend:** React + Vite (single-page app)
- **Indian language APIs:** Sarvam AI (Saaras v3, Mayura, Bulbul v3)
- **International language APIs:** OpenAI (Whisper, GPT-4o-mini, TTS-1)
- **WebRTC:** PeerJS (two-phone remote mode)
- **Hosting:** Vercel (Mumbai region `bom1`) with serverless functions proxying both APIs
- **Domain (planned):** vaaksetu.ai

## Sarvam AI Models (Indian languages)
- **Saaras v3** (`saaras:v3`) — Speech-to-Text via `/speech-to-text`
- **Mayura** (`mayura:v1`) — Translation via `/translate`
- **Bulbul v3** (`bulbul:v3`) — Text-to-Speech via `/text-to-speech`

## OpenAI Models (International languages)
- **Whisper** (`whisper-1`) — STT via `/v1/audio/transcriptions` (transcribe) and `/v1/audio/translations` (→ English)
- **GPT-4o-mini** — Translation via `/v1/chat/completions`
- **TTS-1** — Text-to-Speech via `/v1/audio/speech` (returns mp3 binary)
- Voices: **Male** → `onyx`, **Female** → `nova`

## Architecture — Dual Pipeline

### Sarvam pipeline (Indian ↔ Indian or Indian ↔ English)
Mayura only supports English ↔ Indian language (not Indian ↔ Indian directly).
All translations route through English as pivot:

```
Indian lang speech → Saaras (mode="translate") → English text → Mayura (en→target) → Bulbul TTS
English speech     → Saaras (mode="transcribe") → English text → Mayura (en→target) → Bulbul TTS
Any → English      → Saaras (mode="translate")  → English text → Bulbul TTS (skip Mayura)
```

### OpenAI pipeline (any pair involving an international language)
```
Any speech → Whisper (/translations → English pivot) → GPT-4o-mini (en→target) → TTS-1
Any → English → Whisper (/translations → English) → TTS-1 (skip GPT)
```

### Routing logic
```js
const useOpenAI = !isIndianLang(sourceLang) || !isIndianLang(targetLang);
```
If either language in the pair is international → OpenAI pipeline. Otherwise → Sarvam pipeline.

## Supported Languages

### Indian (Sarvam) — 11 languages
Hindi (`hi-IN`), English (`en-IN`), Bengali (`bn-IN`), Gujarati (`gu-IN`), Kannada (`kn-IN`), Malayalam (`ml-IN`), Marathi (`mr-IN`), Odia (`or-IN`), Punjabi (`pa-IN`), Tamil (`ta-IN`), Telugu (`te-IN`)

**Important:** Odia code is `or-IN` (not `od-IN`). Sarvam rejects `od-IN` with 400.

### International (OpenAI) — 18 languages
Spanish, French, German, Japanese, Chinese, Arabic, Portuguese, Russian, Italian, Korean, Dutch, Turkish, Polish, Swedish, Thai, Vietnamese, Indonesian, Ukrainian

Each person has an **🇮🇳 Indian / 🌍 Intl toggle** in their language selector. Switching toggles changes the dropdown and routes to the appropriate pipeline.

## Project Structure
```
src/
  App.jsx               — Main UI + state + pipeline routing
  pipeline.js           — Sarvam pipeline + OpenAI pipeline functions
  peer.js               — PeerJS helpers (generateRoomCode, hostPeerId, etc.)
  api/
    sarvam.js           — Sarvam API wrappers + AudioContext playback
    openai.js           — OpenAI API wrappers (Whisper, GPT, TTS-1)
  main.jsx              — React entry point
api/
  speech-to-text.js     — Vercel proxy → Sarvam STT (multipart)
  translate.js          — Vercel proxy → Sarvam Mayura
  text-to-speech.js     — Vercel proxy → Sarvam Bulbul
  openai-stt.js         — Vercel proxy → Whisper /transcriptions (multipart)
  openai-stt-translate.js — Vercel proxy → Whisper /translations (→ English)
  openai-chat.js        — Vercel proxy → GPT-4o-mini
  openai-tts.js         — Vercel proxy → TTS-1 (returns raw mp3 binary)
index.html              — HTML entry with fonts (Crimson Pro + DM Sans)
vite.config.js          — Dev proxies (/sarvam → api.sarvam.ai, /openai → api.openai.com)
vercel.json             — Region bom1 (Mumbai) + framework Vite
.npmrc                  — legacy-peer-deps=true (Vite 5 vs @vitejs/plugin-basic-ssl conflict)
.env                    — VITE_SARVAM_API_KEY + VITE_OPENAI_API_KEY (local dev, not committed)
```

## API Configuration

### Dev
- Vite proxies `/sarvam/*` → `https://api.sarvam.ai/*`
- Vite proxies `/openai/*` → `https://api.openai.com/*`
- Keys read from `.env` (`VITE_SARVAM_API_KEY`, `VITE_OPENAI_API_KEY`) or localStorage (setup screen)

### Production (Vercel)
- **No browser-side API keys.** Setup screen hidden in prod.
- Serverless functions inject `SARVAM_API_KEY` and `OPENAI_API_KEY` from Vercel env vars
- Functions deployed in `bom1` (Mumbai) region for minimum latency to Sarvam

### Vercel env vars required
```bash
vercel env add SARVAM_API_KEY production
vercel env add OPENAI_API_KEY production
```

## OpenAI TTS audio handling
OpenAI TTS returns raw mp3 binary (not base64). The `openai-tts.js` Vercel proxy returns it as binary. The `openaiTTS()` function in `src/api/openai.js` fetches the ArrayBuffer and converts to base64 with `arrayBufferToBase64()` so it's compatible with the existing `playBase64Audio()` function in `sarvam.js`. This means replay works identically for both pipelines — messages always store `audioB64`.

## Voices

### Sarvam (Bulbul v3) — Indian languages
- Male → `anand`, Female → `ritu`
- Available speakers (lowercase required): anushka, abhilash, manisha, vidya, arya, karun, hitesh, aditya, ritu, priya, neha, rahul, pooja, rohan, simran, kavya, amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa, kabir, aayan, shubh, ashutosh, advait, anand, tanya, tarun, sunny, mani, gokul, vijay, shruti, suhani, mohit, kavitha, rehan, soham, rupali

### OpenAI (TTS-1) — International languages
- Male → `onyx`, Female → `nova`

### Voice UX model — **Listener's preference**
Each person's voice toggle = the voice they want to *hear* translations in. When Person A speaks, Person B is the listener, so Person B's voice preference is used. Avoids confusion where a speaker sets their own voice but never hears it.

Defaults: Person A → male, Person B → female.
localStorage keys: `vs_langA`, `vs_langB`, `vs_voiceA`, `vs_voiceB`, `vs_ltypeA`, `vs_ltypeB`

## Two-Phone Remote Mode (WebRTC via PeerJS)

### Architecture
- Uses PeerJS (public signaling server) for WebRTC data channel
- Room code: 4-letter code from consonants (`BCDFGHJKMNPQRSTVWXYZ`), prefixed `vaaksetu-XXXX` as PeerJS ID
- Each phone handles its own pipeline independently — only English pivot text is sent over the wire

### Message schema (data channel)
```js
{ type: 'hello', lang: 'hi-IN', voice: 'male' }   // sent on connect + on lang/voice change
{ type: 'english', text: '...', sourceLang: 'hi-IN', ts: 12345 }  // utterance from partner
```

### Flow
1. Host phone: "Create Room" → generates code → waits for peer connection
2. Guest phone: "Join Room" → enters 4-letter code → connects
3. Each phone speaks → STT → English pivot → sent over data channel
4. Receiver gets English text → Mayura/GPT → TTS in their own language/voice

### Routing in remote mode
- If sender's `langA` is Indian → `speechToEnglish()` (Sarvam)
- If sender's `langA` is international → `openaiSpeechToEnglishPipeline()` (Whisper)
- If receiver's `langA` is Indian → `englishToSpeech()` (Sarvam)
- If receiver's `langA` is international → `openaiEnglishToSpeech()` (OpenAI)

### peerState values
`'idle'` → `'hosting'`/`'joining'` → `'connected'` | `'error'`

## Audio Recording & Playback (browser gotchas)

### Recording — MediaRecorder
- MIME type chosen dynamically: `audio/mp4` preferred (iOS), falls back to `audio/webm` (Chrome/Android)
- `MediaRecorder.isTypeSupported()` gates selection
- **Strip codec suffix** from `mediaRecorder.mimeType` before creating Blob — Sarvam rejects `audio/mp4;codecs=opus` but accepts `audio/mp4`
- Filename extension in the form part matches the Blob MIME (`audio.m4a` for mp4, `audio.webm` for webm)
- `getUserMedia` must be called **synchronously within the user gesture** for iOS Safari — never `await` before it
- Minimum blob size check (1000 bytes) to reject accidental taps

### Playback — AudioContext (iOS Safari autoplay)
- iOS Safari blocks `new Audio(...).play()` unless triggered directly by a user gesture
- Fix: module-level `AudioContext` created and `resume()`d inside `unlockAudio()`, called synchronously on every button press
- `playBase64Audio` uses `ctx.decodeAudioData` + `ctx.createBufferSource()` instead of `<audio>` element
- Both Sarvam (WAV base64) and OpenAI (MP3 base64) use the same `playBase64Audio` function — WebAudio decodes both formats

## UI Design
- Dark theme: deep indigo (`#0C0B1A`) background
- Person A accent: amber (`#F5A623`)
- Person B accent: teal (`#0FB8A9`)
- Fonts: Crimson Pro (headers), DM Sans (body)
- Top bar: logo + "📱 Two Phones" button + gear icon (dev only)
- Selector row: per-person Indian/Intl toggle + language dropdown + Male/Female voice toggle
- Hold-to-talk buttons with pulse ring animation while recording
- Remote mode modal: Create Room (shows 4-letter code) / Join Room (input code)

## Features Implemented
- [x] Hold-to-talk recording (Person A / Person B)
- [x] Full STT → Translate → TTS pipeline (Sarvam for Indian, OpenAI for international)
- [x] Independent language selectors for Person A and Person B
- [x] 🇮🇳 Indian / 🌍 Intl toggle per person (routes to Sarvam or OpenAI pipeline)
- [x] 11 Indian languages (Sarvam) + 18 international languages (OpenAI)
- [x] Male / Female voice toggle per person (listener's preference model)
- [x] Preferences persist in localStorage
- [x] Conversation feed with message bubbles
- [x] English pivot text shown as secondary transcript
- [x] Auto-scroll to latest message
- [x] API key setup screen (dev only — Sarvam + OpenAI keys)
- [x] Error handling and display (with specific iOS-mic guidance)
- [x] Replay button on each message bubble
- [x] Processing status indicator with step icons
- [x] Vercel production deployment with serverless API proxy
- [x] Server-side API keys (no browser exposure in production)
- [x] Audio format compatibility for iOS Safari (mp4) and Chrome (webm)
- [x] Two-phone remote mode via PeerJS WebRTC data channel
- [x] Room code pairing (4-letter code, host/guest flow)

## Latency Optimizations

Target: keep perceived latency under ~2s.

Applied:
- **Vercel region `bom1` (Mumbai)** — closest to Sarvam's India-based API
- **Show text immediately** — `onText` callback renders message bubble before TTS completes
- **Pre-warm TCP connection** — HEAD fetch to `/api/speech-to-text` on button press

Pending:
- [ ] Downsample audio to 16kHz mono before upload (~60% smaller payload)
- [ ] Cache TTS audio for common short phrases
- [ ] Stream TTS playback (blocked by Sarvam — no streaming API today)

## Planned Enhancements
- [ ] Register `vaaksetu.ai` domain and point to Vercel
- [ ] iOS app via Expo / React Native
- [ ] Auto-detect source language
- [ ] Live waveform visualizer during recording
- [ ] Clear conversation / reset button
- [ ] Copy transcript text
- [ ] Latency timer per message
- [ ] Mute TTS (text-only mode)
- [ ] Fix STT 400 issue on receiver phone in remote mode (full error text needed for diagnosis)

## Deployment

### Vercel
```bash
vercel              # first-time: creates project
vercel env add SARVAM_API_KEY production
vercel env add OPENAI_API_KEY production
vercel --prod       # deploy to production
```

### Local dev
```bash
npm run dev                 # localhost:5173
npm run dev -- --host       # expose on LAN (HTTPS via self-signed cert)
npm run build               # production build → dist/
```

Add to `.env`:
```
VITE_SARVAM_API_KEY=sk_...
VITE_OPENAI_API_KEY=sk-proj-...
```

To test on phone via LAN: `npm run dev -- --host`, open `https://<your-ip>:5173`, accept self-signed cert warning. Microphone requires HTTPS on iOS Safari.

## Business Context

- **Insight:** Indian language translation is underserved by big tech; Sarvam models significantly outperform Google Translate for Indian languages
- **Moat thinking:** A thin wrapper over APIs is not defensible. Real moat comes from (a) vertical SaaS (hospitals/banks/courts), (b) hardware device (pocket translator / badge), or (c) domain-specific fine-tuning with proprietary conversation data
- **Current phase:** MVP web app as validation tool before committing to iOS/hardware
- **Recommended next step:** validate with 5-10 paying customers in one vertical (healthcare or banking field agents are strongest bets)

## Session History & Decisions (notable)

- Switched from fixed language pairs to independent Person A / Person B dropdowns
- Chose **listener's voice preference** model — speaker never hears their own voice, so listener's preference makes more UX sense
- Serverless API proxy in production: users never see or supply API keys
- `@vitejs/plugin-basic-ssl` added for LAN phone testing → Vite 5 peer-dep conflict → fixed with `.npmrc legacy-peer-deps=true`
- iOS Safari debugging: mic permission → audio format (codec strip) → AudioContext autoplay policy (all resolved)
- Odia language code bug: our app was sending `od-IN` but Sarvam requires `or-IN` → fixed, added localStorage migration
- Added WebRTC two-phone mode (PeerJS): each phone runs its own pipeline, only English pivot text crosses the wire
- Added international language support (18 languages) via OpenAI (Whisper + GPT-4o-mini + TTS-1); dual-pipeline routing based on whether either language is non-Indian
- OpenAI TTS returns raw mp3 binary; converted to base64 in `openaiTTS()` so `playBase64Audio()` works identically for both pipelines

## Commands
```bash
npm run dev               # dev server (localhost:5173)
npm run dev -- --host     # expose on LAN (HTTPS via self-signed cert)
npm run build             # production build
vercel --prod             # deploy to production
```
