# CLAUDE.md — Project Context for VaakSetu

## What is VaakSetu?
VaakSetu (वाक् + सेतु = Voice Bridge) is a bidirectional real-time voice translator supporting Indian and international languages. Two people who don't speak each other's language can either share one device (two tap-to-speak buttons) or use separate phones connected via WebRTC (two-phone remote mode with optional hands-free live conversation).

**Live:** https://vaak-setu.vercel.app

## Tech Stack
- **Frontend:** React + Vite (single-page app)
- **Indian language APIs:** Sarvam AI (Saaras v3, Mayura, Bulbul v3)
- **International language APIs:** OpenAI (Whisper, GPT-4o-mini, TTS-1)
- **Streaming STT:** Sarvam WebSocket (`wss://api.sarvam.ai/speech-to-text/streaming`)
- **WebRTC:** PeerJS (two-phone remote mode)
- **Hosting:** Vercel (Mumbai region `bom1`) with serverless functions proxying both APIs
- **Domain (planned):** vaaksetu.ai

## Sarvam AI Models (Indian languages)
- **Saaras v3** (`saaras:v3`) — STT via `/speech-to-text` (batch) and WebSocket (streaming)
- **Mayura** (`mayura:v1`) — Translation via `/translate`
- **Bulbul v3** (`bulbul:v3`) — Text-to-Speech via `/text-to-speech`

## OpenAI Models (International languages)
- **Whisper** (`whisper-1`) — STT via `/v1/audio/transcriptions` and `/v1/audio/translations` (→ English)
- **GPT-4o-mini** — Translation via `/v1/chat/completions`
- **TTS-1** — Text-to-Speech via `/v1/audio/speech` (returns mp3 binary → converted to base64)
- Voices: **Male** → `onyx`, **Female** → `nova`

## Architecture — Dual Pipeline

### Sarvam pipeline (Indian ↔ Indian or Indian ↔ English)
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

## Streaming STT (Sarvam WebSocket)

### Why
Eliminates the batch STT wait (~800ms). By streaming PCM audio while the user speaks, the transcript is ready by the time they stop. Only Translate → TTS remain (~0.9s vs ~1.7s before).

### Protocol
1. Connect: `wss://api.sarvam.ai/speech-to-text/streaming?api-subscription-key=KEY`
2. Send config JSON: `{ model: "saaras:v3", mode, language_code }`
3. Send binary: raw Int16 PCM, 16 kHz mono (via AudioWorklet)
4. Receive JSON: `{ transcript, is_final }` — multiple partials then one final
5. End: close WebSocket with code 1000 → triggers final transcript

### Implementation (`src/api/sarvam-streaming.js`)
- `SarvamStreamingSTT` class: `start(mediaStream)` → streams; `stop()` → returns `Promise<string>`
- AudioWorklet processor loaded as Blob URL (no separate public/ file needed)
- AudioContext forced to 16 kHz — browser resamples from native rate
- `stop()` races final transcript vs 4s timeout (uses last partial on timeout)
- Falls back to batch STT silently if WebSocket fails to connect

### API key exposure
The streaming WebSocket URL contains the API key as a query param — visible in browser devtools. This is an accepted trade-off for this project. Key is read from `import.meta.env.VITE_SARVAM_API_KEY` (set as a public Vercel env var).

### Fast path in stopRecording
```js
if (pivotFromStream && !useOpenAI) {
  // Skip STT call — streaming already gave us English pivot
  result = await englishToSpeech({ pivotText: pivotFromStream, ... });
}
```

### Live partial transcript
While the user is speaking, streaming partial results appear in the feed as a dashed italic bubble — real-time visual feedback.

### Browser support
Requires `AudioWorkletNode` + `WebSocket` — Chrome, Safari 14.5+, Firefox 76+. Falls back to batch otherwise.

## Conversation UX — Hold-to-Speak + Silence Detection (Go Live)

### Single device (solo mode)
- Buttons are **hold-to-speak**: `onMouseDown`/`onTouchStart` → start, `onMouseUp`/`onTouchEnd` → stop
- `touchAction: 'none'` and `e.preventDefault()` on touch events prevent iOS scroll/zoom interference
- Label: "Hold to Speak" → "Recording…"

### Two-phone remote mode
- Same hold-to-speak button for manual control
- **"Go Live — hands-free"** button (shown when connected) enters continuous conversation mode:
  - Starts listening automatically using silence detection (VAD)
  - Silence detection stops recording → processes → plays translation
  - After translation plays, listening restarts automatically (350ms gap)
  - Status indicator shows: `● Listening` / `● Translating` / `● Ready`
  - "Leave Conversation" exits back to manual hold mode

### Silence detection implementation
```js
// Arms only after MIN_SPEECH_MS of detected speech
// Fires stopRecording after SILENCE_MS of quiet
const SILENCE_THRESHOLD = 10; // RMS amplitude (0–128 scale)
const SILENCE_MS = 1500;
const MIN_SPEECH_MS = 400;
```
Uses refs (`stopRecordingRef`, `startRecordingRef`, `autoConvRef`) to avoid stale closures in `setInterval` callbacks.

### Go Live stream reuse (iOS fix)
In Go Live mode, the MediaStream is kept alive between utterances (`streamRef.current` not stopped). On restart, `setupStream(liveStream)` is called directly instead of calling `getUserMedia` from a `setTimeout` — iOS Safari blocks `getUserMedia` outside a synchronous user gesture, so reusing the stream is essential.

## Supported Languages

### Indian (Sarvam) — 11 languages
Hindi (`hi-IN`), English (`en-IN`), Bengali (`bn-IN`), Gujarati (`gu-IN`), Kannada (`kn-IN`), Malayalam (`ml-IN`), Marathi (`mr-IN`), Odia (`or-IN`), Punjabi (`pa-IN`), Tamil (`ta-IN`), Telugu (`te-IN`)

**Important:** Odia code is `or-IN` (NOT `od-IN`). Sarvam rejects `od-IN` with 400. localStorage migration added.

### International (OpenAI) — 18 languages
Spanish (`es`), French (`fr`), German (`de`), Japanese (`ja`), Chinese (`zh`), Arabic (`ar`), Portuguese (`pt`), Russian (`ru`), Italian (`it`), Korean (`ko`), Dutch (`nl`), Turkish (`tr`), Polish (`pl`), Swedish (`sv`), Thai (`th`), Vietnamese (`vi`), Indonesian (`id`), Ukrainian (`uk`)

Each person has an **🇮🇳 Indian / 🌍 Intl toggle** in their language selector.

## Project Structure
```
src/
  App.jsx               — Main UI + state + pipeline routing + VAD logic
  pipeline.js           — Sarvam pipeline + OpenAI pipeline functions
  peer.js               — PeerJS helpers (generateRoomCode, hostPeerId)
  api/
    sarvam.js           — Sarvam API wrappers + AudioContext playback
    sarvam-streaming.js — WebSocket streaming STT (SarvamStreamingSTT class)
    openai.js           — OpenAI API wrappers (Whisper, GPT, TTS-1)
  main.jsx              — React entry point
api/
  speech-to-text.js         — Vercel proxy → Sarvam STT (multipart)
  translate.js              — Vercel proxy → Sarvam Mayura
  text-to-speech.js         — Vercel proxy → Sarvam Bulbul
  openai-stt.js             — Vercel proxy → Whisper /transcriptions
  openai-stt-translate.js   — Vercel proxy → Whisper /translations (→ English)
  openai-chat.js            — Vercel proxy → GPT-4o-mini
  openai-tts.js             — Vercel proxy → TTS-1 (returns raw mp3 binary)
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
- Keys from `.env` (`VITE_SARVAM_API_KEY`, `VITE_OPENAI_API_KEY`) or localStorage (setup screen)

### Production (Vercel)
- Serverless functions inject `SARVAM_API_KEY` and `OPENAI_API_KEY` from Vercel env vars
- Streaming WebSocket uses `VITE_SARVAM_API_KEY` (public env var, embedded in JS bundle)
- Setup screen hidden in prod

### Vercel env vars required
```bash
vercel env add SARVAM_API_KEY production        # for serverless function proxies
vercel env add VITE_SARVAM_API_KEY production   # for WebSocket streaming (public, in bundle)
vercel env add OPENAI_API_KEY production        # for OpenAI serverless proxies
```

## Audio Recording & Playback

### Recording — MediaRecorder (fallback / batch path)
- MIME: `audio/mp4` preferred (iOS), falls back to `audio/webm`
- Strip `;codecs=...` suffix before creating Blob — Sarvam rejects `audio/mp4;codecs=opus`
- Filename extension matches MIME (`audio.m4a` for mp4, `audio.webm` for webm)
- `getUserMedia` called **synchronously** in user gesture (iOS Safari requirement)
- Min blob size 1000 bytes — rejects accidental taps

### Recording — AudioWorklet (streaming path)
- Raw Int16 PCM at 16 kHz via `AudioWorkletNode`
- Processor loaded as Blob URL (self-contained, no public/ file)
- Streams to WebSocket while user speaks; MediaRecorder runs in parallel as backup
- Both stopped simultaneously via `Promise.all` in `stopRecording`

### Playback — AudioContext
- `playBase64Audio` uses `decodeAudioData` + `createBufferSource` (not `<audio>` element)
- Works for both Sarvam WAV and OpenAI MP3 (both decoded by WebAudio)
- OpenAI TTS ArrayBuffer → `arrayBufferToBase64()` in `openai.js` → same `playBase64Audio` path
- `unlockAudio()` called synchronously in every user gesture for iOS Safari autoplay

## Voices

### Sarvam (Bulbul v3) — Indian
- Male → `anand`, Female → `ritu` (lowercase required)

### OpenAI (TTS-1) — International
- Male → `onyx`, Female → `nova`

### Voice UX model — Listener's preference
Listener's voice preference is used (not the speaker's). When A speaks, B hears the output → B's voice setting applied. Avoids speaker never hearing their own voice.

Defaults: Person A → male, Person B → female.
localStorage keys: `vs_langA`, `vs_langB`, `vs_voiceA`, `vs_voiceB`, `vs_ltypeA`, `vs_ltypeB`

## Two-Phone Remote Mode (WebRTC via PeerJS)

### Flow
1. Host: "Create Room" → 4-letter code → waits
2. Guest: "Join Room" → enters code → connects
3. Each phone speaks → STT → English pivot sent over data channel
4. Receiver → Mayura/GPT → TTS in their language/voice
5. Optional: "Go Live" for hands-free continuous conversation

### Message schema
```js
{ type: 'hello', lang: 'hi-IN', voice: 'male' }                         // on connect + lang change
{ type: 'english', text: '...', sourceLang: 'hi-IN', ts: 12345 }        // utterance
```

### Pipeline routing in remote mode
- Sender Indian lang → `speechToEnglish()` (Sarvam) or streaming STT
- Sender intl lang → `openaiSpeechToEnglishPipeline()` (Whisper)
- Receiver Indian lang → `englishToSpeech()` (Sarvam)
- Receiver intl lang → `openaiEnglishToSpeech()` (OpenAI)

### peerState values
`'idle'` → `'hosting'` | `'joining'` → `'connected'` | `'error'`

### Room codes
4-letter codes from consonants only (`BCDFGHJKMNPQRSTVWXYZ`). PeerJS ID prefixed `vaaksetu-XXXX`.

### ICE / STUN configuration
Both host and guest peers are created with explicit Google STUN servers to improve NAT traversal, especially for laptop ↔ phone across different networks:
```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];
new Peer(id, { config: { iceServers: ICE_SERVERS } });
```

### Cross-device requirement
Both devices **must use the same URL** (both on `https://vaak-setu.vercel.app`, or both on the same LAN dev server). Laptop on `localhost` + phone on production = different signaling contexts, connection will fail.

### AudioContext unlock in remote mode
`unlockAudio()` is called in: `createRoom`, `joinRoom`, `startAutoConversation`, and `conn.on('open')`. This ensures the receiver's AudioContext is pre-warmed before any partner audio arrives, critical for desktop browsers which require a user gesture before audio playback.

## UI Design
- Dark theme: `#0C0B1A` background, Person A amber `#F5A623`, Person B teal `#0FB8A9`
- Fonts: Crimson Pro (headers), DM Sans (body)
- Top bar: logo + "📱 Two Phones" + gear (dev only)
- Selector row: per-person 🇮🇳/🌍 toggle + language dropdown + Male/Female voice toggle
- Conversation feed: message bubbles + live partial transcript (dashed italic, streaming)
- Controls: tap-to-toggle mic buttons (solo) or Live Mode indicator (remote hands-free)
- Remote pairing modal: Create Room (shows code) / Join Room (input code)

## Features Implemented
- [x] Hold-to-speak recording (mouse + touch, iOS-safe)
- [x] Amplitude VAD silence detection in Go Live mode (auto-stops after 1.5s quiet + 400ms speech)
- [x] Streaming STT via Sarvam WebSocket (AudioWorklet → PCM → WS)
- [x] Live partial transcript display while speaking
- [x] Full STT → Translate → TTS pipeline (Sarvam for Indian, OpenAI for international)
- [x] 🇮🇳 Indian / 🌍 Intl toggle per person (11 Indian + 18 international languages)
- [x] Male / Female voice toggle per person (listener's preference model)
- [x] Preferences persist in localStorage
- [x] Conversation feed with message bubbles + replay button
- [x] English pivot text shown as secondary transcript
- [x] Auto-scroll to latest message
- [x] API key setup screen (dev only — Sarvam + OpenAI keys)
- [x] Error handling (iOS-specific mic guidance)
- [x] Processing status indicator with step icons
- [x] Vercel production deployment with serverless API proxy
- [x] Server-side API keys (no browser exposure except streaming key)
- [x] Audio format compatibility (iOS mp4, Chrome webm)
- [x] Two-phone remote mode via PeerJS WebRTC data channel
- [x] Room code pairing (4-letter, host/guest flow)
- [x] Go Live — hands-free continuous conversation mode (two-phone)

## Latency Profile

| Step | Before streaming | After streaming |
|------|-----------------|-----------------|
| STT | ~800ms (batch) | ~0ms (already done) |
| Translate | ~400ms | ~400ms |
| TTS | ~500ms | ~500ms |
| **Total after stop** | **~1.7s** | **~0.9s** |

Additional optimisations in place:
- Vercel `bom1` (Mumbai) — closest region to Sarvam
- `onText` callback renders message bubble before TTS completes
- HEAD pre-warm fetch on button press

Pending:
- [ ] Downsample audio to 16kHz mono for batch path (~60% smaller payload)
- [ ] Cache TTS for common short phrases

## Known Issues / Pending
- [ ] Streaming STT Sarvam protocol assumptions (config format, field names) need validation against actual Sarvam docs once available
- [ ] Two-phone Go Live: auto-restart timing (350ms gap) may need tuning per device
- [ ] No TURN servers configured — WebRTC may fail on symmetric NAT (enterprise/VPN networks); would need a paid TURN provider (e.g. Twilio, Metered) for full reliability

## Deployment

### Vercel
```bash
vercel env add SARVAM_API_KEY production
vercel env add VITE_SARVAM_API_KEY production   # same key — needed for WebSocket streaming
vercel env add OPENAI_API_KEY production
vercel --prod
```

### Local dev
```bash
npm run dev               # localhost:5173
npm run dev -- --host     # LAN HTTPS (self-signed cert)
npm run build             # production build → dist/
```

`.env` file:
```
VITE_SARVAM_API_KEY=sk_...
VITE_OPENAI_API_KEY=sk-proj-...
```

## Business Context
- Sarvam models outperform Google Translate for Indian languages — key differentiator
- Moat: vertical SaaS (hospitals/courts/banks), hardware device, or proprietary conversation data
- Current phase: MVP web app for validation
- Recommended next step: 5-10 paying customers in one vertical (healthcare or banking)

## Session History & Decisions

- Fixed language pairs → independent per-person dropdowns
- Listener's voice preference model (speaker never hears own voice)
- Serverless API proxy in prod — no user key exposure (except streaming WS)
- `.npmrc legacy-peer-deps=true` for Vite 5 vs @vitejs/plugin-basic-ssl conflict
- iOS Safari: sync getUserMedia, codec strip, AudioContext unlock — all resolved
- Odia code bug: `od-IN` → `or-IN`, with localStorage migration
- Added WebRTC two-phone mode (PeerJS, English pivot over data channel)
- Added 18 international languages via OpenAI dual-pipeline
- OpenAI TTS returns binary mp3 → base64 in client, reuses `playBase64Audio`
- Hold-to-talk → tap-to-toggle → reverted back to hold-to-speak (iOS getUserMedia timing issues with tap)
- Added Go Live hands-free mode for two-phone: VAD loop with auto-restart after TTS
- Go Live iOS fix: reuse MediaStream between utterances; never call getUserMedia from setTimeout
- Sarvam announced WebSocket streaming STT + batch job API; implemented streaming
- Streaming uses AudioWorklet Blob URL (no public/ file needed), 16kHz PCM
- Key exposure accepted for WebSocket URL; VITE_SARVAM_API_KEY as public Vercel env var
- Two-phone mode laptop↔phone fix: added Google STUN servers (ICE_SERVERS) to PeerJS config
- unlockAudio() called at conn.on('open') and startAutoConversation() to pre-warm AudioContext on receiver side
- Both devices must use the same URL for WebRTC signaling to work (can't mix localhost + production)

## Commands
```bash
npm run dev               # dev server (localhost:5173)
npm run dev -- --host     # LAN HTTPS
npm run build             # production build
vercel --prod             # deploy to production
```
