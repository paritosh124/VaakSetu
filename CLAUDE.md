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

## OpenAI Models (International languages) — fallback only
- **Whisper** (`whisper-1`) — STT via `/v1/audio/transcriptions` and `/v1/audio/translations` (→ English)
- **GPT-4o-mini** — Translation via `/v1/chat/completions`
- **TTS-1** — Text-to-Speech via `/v1/audio/speech` (returns mp3 binary → converted to base64)
- Voices: **Male** → `onyx`, **Female** → `nova`

## Groq + ElevenLabs (preferred international pipeline)
Used by default for any language pair involving an international language; the
OpenAI pipeline remains as a last-resort fallback. Roughly 20–40× cheaper per
minute than OpenAI with comparable quality.

- **Groq Whisper** (`whisper-large-v3`) — STT via `/openai/v1/audio/transcriptions`
  - **Important:** must use `whisper-large-v3`, NOT `whisper-large-v3-turbo` — turbo does not support the `/translations` endpoint. We transcribe first, then translate with Llama.
  - Language param must be ISO-639-1 (`hi`, not `hi-IN`). Normalize via `sourceLang.split('-')[0]`.
- **Groq Llama** (`llama-3.3-70b-versatile`) — Translation via `/openai/v1/chat/completions`
  - The 8B variant hallucinates on translation tasks; 70B is reliable.
  - Wrap user text in `<translate>...</translate>` XML tags so the model doesn't interpret a phrase like "give me tips" as an instruction to itself.
  - `temperature: 0.0`, `max_tokens: 500`.
  - System prompt: *"You are a translation engine. The user will send text inside `<translate>` tags. Translate that text to {targetLangName}. Output ONLY the translated text — no tags, no explanation, no extra content."*
- **ElevenLabs Turbo v2.5** (`eleven_turbo_v2_5`) — TTS via `/v1/text-to-speech/{voiceId}`
  - Male → `onwK4e9ZLuTAKqWW03F9` (Daniel), Female → `EXAVITQu4vr4xnSDxMaL` (Sarah)
  - Returns raw mp3 binary → `arrayBufferToBase64()` → same `playBase64Audio` path

If no ElevenLabs key is available, the pipeline falls back to browser-native
`speechSynthesis` (`browserTTS` in `src/api/groq.js`). Quality is acceptable
for European languages on desktop Chrome but poor for CJK/Arabic — the replay
button is also disabled because the Web Speech API doesn't return audio data.

## Architecture — Dual Pipeline

### Sarvam pipeline (Indian ↔ Indian or Indian ↔ English)
```
Indian lang speech → Saaras (mode="translate") → English text → Mayura (en→target) → Bulbul TTS
English speech     → Saaras (mode="transcribe") → English text → Mayura (en→target) → Bulbul TTS
Any → English      → Saaras (mode="translate")  → English text → Bulbul TTS (skip Mayura)
```

### Groq + ElevenLabs pipeline (default international path) — HYBRID
`runGroqPipeline` (solo), `groqEnglishToSpeech` (remote receiver), and the
extension's `translateAudio` all pick the engine for each step independently,
so an intl→Indian call uses Sarvam's native Indic voices instead of
ElevenLabs speaking Hindi with a European accent.

```
STT (source → English pivot):
  source Indian → Saaras v3 (translate mode — emits English directly)
  source intl   → Groq Whisper + Llama (transcribe, then translate to English)

Translate (pivot → target text):
  target == English → skip
  target Indian     → Mayura (better Indic fluency than Llama)
  target intl       → Groq Llama 70B

TTS (text → audio):
  target Indian → Bulbul v3 (anand / ritu)
  target intl   → ElevenLabs Turbo v2.5 (Daniel / Sarah)
```

Why hybrid: ElevenLabs pronounces Devanagari/Tamil/etc with an English accent
that sounds wrong to native speakers, and Bulbul can't speak European
languages. Mixing engines per step keeps every output in the best available
voice for that language. `runGroqPipeline` takes `sarvamKey` alongside
`groqKey` / `elevenLabsKey` so dev mode can hit Sarvam directly (in prod the
serverless proxy injects the key).

### OpenAI pipeline (fallback, only if no Groq key present)
```
Any speech → Whisper (/translations → English pivot) → GPT-4o-mini (en→target) → TTS-1
Any → English → Whisper (/translations → English) → TTS-1 (skip GPT)
```

### Routing logic (three-way)
```js
const needsIntl = !isIndianLang(sourceLang) || !isIndianLang(targetLang);
// effectiveGroqKey falls back to import.meta.env.VITE_GROQ_API_KEY so a
// fresh tab with cleared state still picks the right pipeline.
const effectiveGroqKey = groqKey || import.meta.env.VITE_GROQ_API_KEY || '';
const useGroq   = needsIntl && !!effectiveGroqKey;
const useOpenAI = needsIntl && !useGroq && !!openaiKey;
// Neither truthy → fall through to Sarvam (Indian ↔ Indian only)
```
The same pattern is repeated in three sites: `stopRecording` (solo), the remote branch, and `handlePartnerMessage`.

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

**Important:** Odia code is inconsistent across Sarvam APIs:
- STT (Saaras): uses `or-IN`
- Translate (Mayura) + TTS (Bulbul): uses `od-IN`
- App stores `or-IN` everywhere (canonical). `toSTTCode` / `toNonSTTCode` helpers in `sarvam.js` normalise per call site.
- localStorage migration: `od-IN` → `or-IN` already in place.

### International (OpenAI) — 18 languages
Spanish (`es`), French (`fr`), German (`de`), Japanese (`ja`), Chinese (`zh`), Arabic (`ar`), Portuguese (`pt`), Russian (`ru`), Italian (`it`), Korean (`ko`), Dutch (`nl`), Turkish (`tr`), Polish (`pl`), Swedish (`sv`), Thai (`th`), Vietnamese (`vi`), Indonesian (`id`), Ukrainian (`uk`)

Each person has an **🇮🇳 Indian / 🌍 Intl toggle** in their language selector.

## Project Structure
```
src/
  App.jsx               — Main UI + state + pipeline routing + VAD logic
  pipeline.js           — Sarvam + OpenAI + Groq+ElevenLabs pipeline functions
  peer.js               — PeerJS helpers (generateRoomCode, hostPeerId)
  api/
    sarvam.js           — Sarvam API wrappers + AudioContext playback
    sarvam-streaming.js — WebSocket streaming STT (SarvamStreamingSTT class)
    openai.js           — OpenAI API wrappers (Whisper, GPT, TTS-1)
    groq.js             — Groq Whisper + Llama wrappers + browserTTS fallback
    elevenlabs.js       — ElevenLabs Turbo v2.5 TTS wrapper
  main.jsx              — React entry point
api/
  _cors.js                  — handlePreflight() helper for CORS OPTIONS
  speech-to-text.js         — Vercel proxy → Sarvam STT (multipart)
  translate.js              — Vercel proxy → Sarvam Mayura
  text-to-speech.js         — Vercel proxy → Sarvam Bulbul
  openai-stt.js             — Vercel proxy → Whisper /transcriptions
  openai-stt-translate.js   — Vercel proxy → Whisper /translations (→ English)
  openai-chat.js            — Vercel proxy → GPT-4o-mini
  openai-tts.js             — Vercel proxy → TTS-1 (returns raw mp3 binary)
  groq-stt-translate.js     — Vercel proxy → Groq Whisper /transcriptions
  groq-chat.js              — Vercel proxy → Groq Llama /chat/completions
  elevenlabs-tts.js         — Vercel proxy → ElevenLabs /v1/text-to-speech/{id}
extension/                  — Chrome MV3 extension (see §"Chrome Extension MVP")
  manifest.json             — MV3 manifest, permissions, host access
  background.js             — Service worker; message router + lifecycle
  popup/                    — Toolbar popup (lang select + start/stop)
  offscreen/                — Hidden page holding MediaStreams + MediaRecorder
  widget/                   — Content script — floating push-to-talk overlay
  lib/                      — Ported copies of pipeline + api wrappers (no Vite env)
  icons/                    — 16/48/128 placeholder PNGs
index.html              — HTML entry with fonts (Crimson Pro + DM Sans)
vite.config.js          — Dev proxies (/sarvam, /openai, /groq, /elevenlabs)
vercel.json             — Region bom1 (Mumbai) + framework Vite + CORS headers for /api/*
.npmrc                  — legacy-peer-deps=true (Vite 5 vs @vitejs/plugin-basic-ssl conflict)
.env                    — VITE_SARVAM_API_KEY + VITE_GROQ_API_KEY + VITE_ELEVENLABS_API_KEY + VITE_OPENAI_API_KEY (local dev, not committed)
BUSINESS_PLAN.md        — Strategy notes (not committed; in .gitignore)
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
Each external API needs **two** env vars when the client decides which pipeline to use:
- `VITE_*` — baked into the client bundle at build time → lets `App.jsx` routing pick the right pipeline
- Plain (no prefix) — read at runtime by the serverless function → actual upstream auth

```bash
# Sarvam
vercel env add SARVAM_API_KEY production         # for serverless function proxies
vercel env add VITE_SARVAM_API_KEY production    # for WebSocket streaming (public, in bundle)

# Groq (preferred international pipeline)
vercel env add GROQ_API_KEY production
vercel env add VITE_GROQ_API_KEY production      # so client routes to Groq, not OpenAI

# ElevenLabs (voice quality for international)
vercel env add ELEVENLABS_API_KEY production
vercel env add VITE_ELEVENLABS_API_KEY production

# OpenAI (fallback — optional; removing it ensures no accidental billing)
vercel env add OPENAI_API_KEY production
vercel env add VITE_OPENAI_API_KEY production
```

After any env var change, redeploy: `vercel --prod` (existing deployments don't auto-refresh env).

### Key-routing state hydration (envOr + effectiveGroqKey)
Two subtle patterns matter for selecting the right pipeline:

```js
// src/App.jsx ~line 75 — prefer .env value, fall back to localStorage only
// when the env var is truly absent. An intentionally empty `VITE_OPENAI_API_KEY=`
// does NOT leak stale localStorage keys.
const envOr = (envVal, stored) => (envVal !== undefined && envVal !== '' ? envVal : stored);
const [groqKey, setGroqKey] = useState(
  isProd ? '' : envOr(import.meta.env.VITE_GROQ_API_KEY, storedGroqKey),
);
```

```js
// Inside pipeline-routing sites, fall back to the raw env var if state is
// still empty (covers HMR/state-hydration edge cases). Also require a
// non-empty openaiKey before OpenAI is even considered.
const effectiveGroqKey = groqKey || import.meta.env.VITE_GROQ_API_KEY || '';
const useGroq   = needsIntl && !!effectiveGroqKey;
const useOpenAI = needsIntl && !useGroq && !!openaiKey;
```

A defensive `useEffect` also clears any stale `openai_key` out of localStorage whenever `groqKey` is present, so nothing can quietly leak back in across reloads.

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
- [x] Groq + ElevenLabs pipeline as default for international languages (OpenAI → fallback)
- [x] CORS on all `/api/*` endpoints for extension use
- [x] Chrome MV3 extension MVP (tabCapture + mic + push-to-talk, speakerphone routing)

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
VITE_GROQ_API_KEY=gsk_...
VITE_ELEVENLABS_API_KEY=sk_...
VITE_OPENAI_API_KEY=               # leave empty to keep OpenAI out of the routing
```

## CORS for /api/* (required by the extension)
The Chrome extension calls `https://vaak-setu.vercel.app/api/*` from a
`chrome-extension://…` origin, so every serverless function must handle CORS.

- `vercel.json` sets the response headers globally for `/api/(.*)`:
  `Access-Control-Allow-Origin: *`,
  `Access-Control-Allow-Methods: POST, OPTIONS`,
  `Access-Control-Allow-Headers: Content-Type, Authorization, api-subscription-key, xi-api-key`.
- `api/_cors.js` exports `handlePreflight(req, res)` which short-circuits OPTIONS requests with a 204. Every `/api/*.js` starts with:
  ```js
  import { handlePreflight } from './_cors.js';
  export default async function handler(req, res) {
    if (handlePreflight(req, res)) return;
    // ... normal logic
  }
  ```
- The webapp itself doesn't need CORS (same origin as the functions), but ship the headers for extension + any future third-party integration.

## Chrome Extension MVP (`extension/`)

### Goal
Agent-side deployment for call centers: a push-to-talk overlay that works on top of **any** browser-based softphone (Google Meet, Zoom Web, Teams, Genesys Cloud, Freshcaller, Talkdesk, Exotel dialer). Zero integration work for the call-center platform.

### Audio routing (phase 1 — "speakerphone mode")
- Customer side: `chrome.tabCapture` grabs tab audio → translated → played through speakers → agent hears translation.
- Agent side: `getUserMedia` grabs mic → translated → played through speakers → customer's phone microphone picks it up.
- Limitation: customer hears slight echo + background. Phase 2 will use a virtual audio cable (VB-Cable on Windows, BlackHole on macOS) for clean routing.

### MV3 architecture — 4 contexts
| Context | File | Role |
|---|---|---|
| **Toolbar popup** | `popup/popup.js` | Language selection, voice gender, Start/Stop. **Triggers mic permission prompt** (see below). |
| **Service worker (background)** | `background.js` | Message router + lifecycle. Creates/destroys offscreen document. Gets tab `streamId` via `chrome.tabCapture.getMediaStreamId`. Forwards messages between widget and offscreen. |
| **Offscreen document** | `offscreen/offscreen.js` | Hidden page (MV3 can't hold MediaStreams in a service worker). Does `getUserMedia({mandatory: {chromeMediaSource:'tab', chromeMediaSourceId}})` for tab audio, `getUserMedia({audio:true})` for mic, runs `MediaRecorder`, runs pipeline, plays TTS via WebAudio. |
| **Content script (widget)** | `widget/widget.js` | Floating draggable overlay injected into the call tab. Push-to-talk buttons, transcript feed. Sends commands (`recordCustomer` / `recordAgent` / `stopRecord`) to background. |

### Message protocol
- **Popup → background:** `{type: 'start', tabId}` / `{type: 'stop'}`
- **Widget → background:** `{type: 'recordCustomer' | 'recordAgent' | 'stopRecord' | 'requestStop'}`
- **Background → offscreen:** `{to: 'offscreen', cmd: 'init' | 'recordCustomer' | 'recordAgent' | 'stopRecord' | 'stop', ...}`
- **Offscreen → widget (via background):** `{to: 'widget', tabId, event: 'show' | 'hide' | 'ready' | 'status' | 'message' | 'error', ...}`
  - Background routes `to: 'widget'` messages via `chrome.tabs.sendMessage(tabId, msg)` — content scripts don't receive `chrome.runtime.sendMessage` from other extension contexts directly.

### Microphone permission in MV3 — CRITICAL
Offscreen documents **cannot** request mic permission on their own. They have no user gesture and no UI to surface Chrome's permission prompt, so `getUserMedia({audio:true})` fails silently.

**Fix pattern:** trigger the permission prompt from the popup (which has a user gesture from the toolbar click). Once granted, the entire `chrome-extension://<id>` origin is unlocked — offscreen then inherits the permission.

```js
// popup.js — inside onToggle, before sending `start` to background:
async function ensureMicPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop()); // we just wanted the grant
  } catch (err) {
    throw new Error('Microphone permission denied. Allow in site settings and retry.');
  }
}
```

Offscreen should still **lazy-retry** on first agent-press rather than hard-failing at init — this covers cases where init happened before the grant propagated.

### Tab audio passthrough
`tabCapture` mutes the source tab by default. To keep the call audible while we also record it, fan the captured stream back out to the speakers in the offscreen doc:
```js
passthroughCtx = new AudioContext();
passthroughCtx.createMediaStreamSource(tabStream).connect(passthroughCtx.destination);
```

### Porting vs. bundling
The extension ships its own copies of `pipeline.js` + `api/sarvam.js|groq.js|elevenlabs.js` under `extension/lib/` because:
- The webapp versions use `import.meta.env.DEV` to switch between dev proxy and prod serverless paths — the extension has no Vite env at all.
- `API_BASE` in `extension/lib/config.js` is hardcoded to `https://vaak-setu.vercel.app/api`. Change it there if pointing at localhost; also add the local URL to `host_permissions` in `manifest.json`.
- No streaming STT in the extension — batch only. Good enough for MVP; revisit if latency matters on real calls.

### Installing (dev, unpacked)
1. Deploy the backend first with all Vercel env vars set (otherwise API calls 401).
2. `chrome://extensions` → Developer mode on → Load unpacked → pick `extension/`.
3. Pin the icon to the toolbar.
4. Content scripts only inject into tabs opened **after** the extension loaded — if the widget doesn't appear, reload the call tab.

### Explicitly out-of-scope for phase 1
- Usage/minutes logging (paused pending login design).
- Per-agent config beyond language + voice + output device.

## Chrome Extension — Go Live (hands-free, low-latency)

Conversational layer for live calls (Google Meet etc.): once the agent clicks
**Go Live** on the floating widget, VaakSetu listens to both sides
continuously, streams customer/agent speech to Sarvam over WebSocket, and
plays back translated audio with the same latency profile as the webapp
(~0.9s after the speaker stops). Push-to-talk still works; Go Live is
additive.

### Architecture
```
tab audio (customer) ─► VAD ─► SarvamStreamingSTT ─► partial transcripts ─► widget
                                     │
                                     ▼ (on silence)
                              pivot (English)
                                     │
mic audio   (agent)   ─► VAD ─► ────┤
                                     ▼
                               turnQueue (serial)
                                     │
                                     ▼
              pivotToSpeech   (Mayura + Bulbul | Groq Llama + ElevenLabs)
                                     │
                                     ▼
                     playBase64Audio(b64, { sinkId })
                                     │
                                     ▼
                speakers | VB-Cable | BlackHole (Meet mic input)
```

- **VAD** (`createVadLoop` in `extension/offscreen/offscreen.js`):
  AnalyserNode RMS sampled every 60ms on each stream. Thresholds:
  `SILENCE_THRESHOLD=12`, `SILENCE_MS=1500`, `MIN_SPEECH_MS=400`.
  On speech onset → `beginCapture(who)`; on sustained silence →
  `endCapture(who)`.
- **beginCapture** opens both a streaming STT (if source is Indian —
  Sarvam only) and a batch `MediaRecorder` in parallel. Batch is used for
  intl sources (Groq Whisper) and as a fallback if the WebSocket drops.
- **endCapture** stops the streamer (final transcript), stops the recorder
  (blob), enqueues the turn. Only one `activeCapture` at a time; concurrent
  VAD wake-ups on the *other* side are ignored until the current capture
  closes.
- **Turn queue**: `pumpQueue` processes turns serially. During
  translate+TTS playback, the **opposite** side's VAD is paused so the
  translation coming out of speakers doesn't retrigger a turn through the
  call audio. The speaker's own VAD stays armed so they can start the next
  utterance immediately.
- **Feedback guard**: pause/resume is enough when output goes to a virtual
  audio cable (no acoustic loop). With default speakers, echo cancellation
  on the mic plus the VAD pause is enough in practice — recommend
  headphones-with-mic for clean operation.

### Pipeline split (`extension/lib/pipeline.js`)
- `translateAudio({ audioBlob, ... })` — batch path (push-to-talk and
  intl-source Go Live). Runs full STT + translate + TTS.
- `pivotToSpeech({ pivotText, ... })` — fast path when streaming STT has
  already produced the English pivot. Translate + TTS only. Same hybrid
  engine choice per step as the webapp.

Both return `{ audioB64, audioPromise, ... }` where `audioB64` is an array
(multi-chunk for Bulbul 500-char splits, single-element for ElevenLabs /
OpenAI). `audioPromise` resolves when all chunks have finished playing.

### Output device routing — dual-sink (VCC for outgoing, headphones for incoming)
The translated audio for the two directions must land on **different**
output devices:

- **Agent speaks →** translated audio must go to the *customer*, which
  means it has to end up as Meet's microphone input. Send it to the
  virtual audio cable.
- **Customer speaks →** translated audio is for the *agent*'s ears. Send
  it to the headphones.

A single sink can't do both: if you play into VCC only, you hear nothing;
if you play into headphones only, the customer still hears your raw voice.

UI & storage:
- Popup shows two dropdowns:
  `Customer hears (→ Meet's mic)` → persisted as `sinkAgent` (plays
  translation of agent's speech).
  `You hear` → persisted as `sinkCustomer` (plays translation of
  customer's speech).
- Background reads both and forwards via offscreen `init`. Legacy
  `outputSinkId` is migrated to `sinkAgent` on first load.
- Offscreen's `sinkFor(who)` picks `sinkAgent` when `who==='agent'`,
  otherwise `sinkCustomer`. Both `runBatchTurn` and the Go Live queue use
  it.
- `playBase64Audio(b64, { sinkId })` keeps a `Map` of AudioContexts keyed
  by sinkId — `new AudioContext({ sinkId })` on Chrome 110+ — so
  switching outputs doesn't reset state.

Tab-audio passthrough:
- `tabCapture` auto-mutes the source tab. The offscreen creates a
  passthrough (`passthroughSrc → passthroughCtx.destination`) so PTT mode
  keeps the call audible between taps.
- In **Go Live** the passthrough is disconnected (`pausePassthrough()`);
  otherwise the customer's raw voice would fight the translation in the
  agent's ears. Reconnected on `stopGoLive`.

Required external setup (Windows example — macOS uses BlackHole similarly):
1. Install **VB-Audio Virtual Cable** (free, one driver).
2. In the VaakSetu popup:
   - `Your microphone` → your physical headset / laptop mic (NOT CABLE Output)
   - `Customer hears (→ Meet's mic)` → **CABLE Input (VB-Audio Virtual Cable)**
   - `You hear` → your headphones
3. In Google Meet → Settings → Audio:
   - Microphone → **CABLE Output (VB-Audio Virtual Cable)**
   - Speakers → your headphones (same as VaakSetu's "You hear")

### The "silent mic" trap
Installing a virtual audio cable often flips Windows' system default input
to CABLE Output, because it's the newest device. If VaakSetu were relying
on `getUserMedia({ audio: true })` (system default), it would capture the
silent virtual cable instead of the agent's real mic — RMS ~1, no speech
ever detected. The popup therefore exposes an explicit `micDeviceId`
selector, and offscreen captures via `getUserMedia({ audio: { deviceId:
{ exact: id } } })`. A log line `[vaaksetu] mic captured from: <label>`
confirms which device the track actually bound to.

### Streaming STT in the extension
- Ported to `extension/lib/api/sarvam-streaming.js`. Uses `self.AudioContext`
  (offscreen doc context), 16 kHz PCM Int16 over WebSocket.
- The extension can't bake `VITE_SARVAM_API_KEY` at build time, so it
  fetches the key at runtime from `/api/sarvam-ws-key` (see
  `api/sarvam-ws-key.js`). The key is cached per offscreen session.
- Streaming is only engaged for Indian source languages (Sarvam
  constraint). Intl sources use the batch `MediaRecorder` blob → Groq
  Whisper path.

### 500-char / 1000-char limit fixes (applies to webapp and extension)
- **Bulbul TTS** rejects >500 chars. `textToSpeech` in both
  `src/api/sarvam.js` and `extension/lib/api/sarvam.js` now splits input
  via `chunkText(text, maxLen)` (sentence boundaries → comma fallback →
  whitespace fallback) and returns `string[]` of base64 clips. Callers
  play sequentially.
- **Mayura translate** rejects >1000 chars. `translateText` chunks at
  `MAX_TRANSLATE_CHARS = 900`, runs `translateOne` per chunk, joins with
  spaces.
- `audioB64` in all pipeline results is now an array (single-element for
  ElevenLabs/OpenAI, multi for Bulbul). The webapp's replay button
  iterates; the extension's `audioPromise` awaits each chunk in order.

### Widget additions
- **Go Live toggle button** below the PTT pair. Sends
  `{ type: 'goLive' | 'stopGoLive' }` to background. PTT buttons disable
  while Go Live is active.
- **Partial transcript bubble** (`.vs-partial`): dashed, italic, color-coded
  per speaker. Updated on every `partial` event from offscreen, cleared on
  `message` arrival (the finalized turn) or `goLive { on: false }`.
- **Copyable feed**: `.vs-feed` and descendants set to `user-select: text`
  so conversation text can be copied out. Widget root remains
  `user-select: none` to keep the header draggable.

### Updated file layout
```
api/
  sarvam-ws-key.js          — runtime Sarvam-key endpoint for extension
extension/
  lib/api/
    sarvam-streaming.js     — ported SarvamStreamingSTT
    sarvam.js               — sinkId-aware playBase64Audio, chunked TTS
  lib/
    pipeline.js             — split: translateAudio + pivotToSpeech
  offscreen/offscreen.js    — VAD, streaming capture, turn queue
  popup/                    — output-device picker
  widget/                   — Go Live button, partial bubble, copyable feed
```

### Vercel env vars (extension-specific)
No new server-side keys beyond what the webapp uses. The extension's
`/api/sarvam-ws-key` reads the same `SARVAM_API_KEY` already deployed.

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
- Added Groq + ElevenLabs as cheaper international pipeline; OpenAI demoted to fallback
- Groq: must use `whisper-large-v3` (not `-turbo` — no `/translations` endpoint); language param must be ISO-639-1
- Groq Llama 70B required — 8B hallucinates on translation; 70B is reliable
- Groq Llama prompt wraps input in `<translate>` XML tags so "give me tips" isn't interpreted as an instruction
- Added `envOr` helper: prefer .env value, fall back to localStorage only when env is truly absent (not empty string) — prevents stale OpenAI keys from overriding an intentional empty `VITE_OPENAI_API_KEY=`
- Three-way routing with `effectiveGroqKey`: falls back to `import.meta.env.VITE_GROQ_API_KEY` if state is still empty; OpenAI path now requires non-empty `openaiKey` before firing
- Defensive `useEffect` clears stale `openai_key` from localStorage whenever `groqKey` is present
- Added CORS to `/api/*`: `vercel.json` headers block + `api/_cors.js` `handlePreflight()` imported by every serverless function
- Built Chrome MV3 extension (`extension/`) for call-center agent deployment — push-to-talk overlay, tabCapture + getUserMedia, speakerphone-mode audio routing
- Extension mic permission fix: popup triggers `getUserMedia({audio:true})` before sending `start` — offscreen docs inherit the grant. Lazy retry on first agent press for resilience.
- Added Go Live hands-free mode in the extension: per-stream VAD + Sarvam streaming STT + serial turn queue + opposite-side VAD pause during TTS. Parity with the webapp's latency profile (~0.9s after stop).
- Split extension pipeline into `translateAudio` (batch) and `pivotToSpeech` (fast path when streaming STT already produced the pivot). Both return `audioB64` as an array to accommodate Bulbul's 500-char chunking.
- Added `chunkText` + chunked `textToSpeech` / `translateText` in both webapp and extension to dodge Bulbul's 500-char and Mayura's 1000-char limits. TTS now returns `string[]`; callers play sequentially.
- Added `/api/sarvam-ws-key` serverless endpoint so the extension (no build-time Vite env) can fetch the Sarvam key at runtime for streaming WebSocket.
- Added dual-sink output routing in the extension: `sinkAgent` (agent speech translation → feeds Meet's mic via VB-Cable / BlackHole) and `sinkCustomer` (customer speech translation → agent's headphones). Single-sink setups couldn't deliver both directions simultaneously.
- Replaced tab-audio passthrough with `chrome.tabs.update({ muted: true })` on startSession. The MV3 `tabCapture.getMediaStreamId` API does NOT auto-mute the source (unlike the old `tabCapture.capture`), so the agent was hearing raw customer voice alongside the translation. Muting the tab at the OS sink level is the clean fix — `tabCapture` taps upstream of the mute so analysis still receives the audio. Unmuted on stopSession.
- Extension voice semantics flipped from listener-preference to **speaker-preference** to match the popup's "Agent voice" being grouped under "Agent speaks" — users intuitively expected `agentVoice` to be the voice used when the agent speaks (heard by the customer). Webapp keeps listener-preference unchanged.
- Added explicit **mic device picker** in popup (`micDeviceId`) — installing a virtual audio cable on Windows often flips the system default input to CABLE Output (silent), so relying on `getUserMedia({audio:true})` was capturing nothing. Offscreen now uses `{ deviceId: { exact } }` and logs `mic captured from: <label>` for diagnosis.
- **VAD rewrite (Go Live)**: gap-tolerant sustained-speech model. Old algorithm reset the "speaking" counter on any sub-threshold sample, so real speech with micro-pauses never armed. New model accumulates active time and only resets if inactivity exceeds `GAP_TOLERANCE_MS=250`. Threshold lowered to 6 (AGC often compresses signals to 8–15 even during speech). `SILENCE_MS` dropped 1500→900 — single biggest end-to-end latency win in the pipeline.
- Added `onNoSignal` callback (fires after 6s of peakRms < 1.5) → surfaces clear error to widget instead of silently hanging on a misconfigured mic/tab.
- **TTS pipelining**: `textToSpeech` in the extension now accepts an `onChunk` callback. `pivotToSpeech` starts playing Bulbul chunk N while chunk N+1 is still being generated by Sarvam. For 3-chunk Indic utterances, perceived start-of-audio latency is roughly halved.
- **Timing logs**: offscreen emits `[vaaksetu timing <who>] +<ms> <step>` for every pipeline stage plus a summary `READY +Xms | PLAYED +Yms` line (X = end-of-speech to audio-ready, Y = to end-of-playback). Used for locating slow steps.
- **Sentence-level streaming** (extension Go Live): new `SarvamSentenceStreamer` wraps the raw STT stream and emits per-sentence events when partials contain a terminal mark (`. ! ? ।  ॥  。`) or go idle for 650ms. Each sentence fires `pivotToAudio` (translate + TTS → base64 array) immediately; playback is serialized via an in-turn `playChain`. Net effect: the listener hears the first translated sentence while the speaker is still producing the next, so long utterances no longer wait for end-of-speech to start speaking.
- **New `pivotToAudio` pipeline variant** (extension + webapp): identical to `pivotToSpeech` but returns `{ audios }` without auto-playing, so multiple sentences can translate + TTS in parallel while the caller keeps audio in order.
- **Webapp solo Go Live (auto-detect)**: new button in single-device mode starts a continuous VAD loop on the mic. Each utterance is batched through Saaras with `language_code: 'unknown'`, the detected language routes the turn to the OTHER configured language, and playback is chained. Script-based fallback (Devanagari vs Latin) handles cases where Sarvam returns a variant code.
- **Streamer-stop fast path** (applied to both webapp and extension): `SarvamStreamingSTT.stop()` no longer waits up to 4s for Sarvam's explicit "final" message. If `_lastPartial` exists when VAD fires speech-end, it races the final against a 250ms window and returns the partial if the final hasn't arrived yet. The final is usually just punctuation/casing cleanup — shaving 1–4s off every Go Live / auto-stop turn is a far better trade. Only the no-partial case (very short utterance) waits longer, 1.2s max.
- Added text logs: `[vaaksetu text <who>] pivot (<src>): "…"` and `final (<tgt>): "…"` to disambiguate STT-quality issues (pivot wrong) from translation-quality issues (pivot right, translated text wrong).
- **Mayura mode flipped to `formal`** in both extension and webapp. `modern-colloquial` preserves common English words ("new plan buy please help") by design — fine for urban Hinglish audiences, broken for call-center customers who only speak the target language. Both paths now strictly translate everything.
- **Host permissions updated**: `extension/manifest.json` now lists `https://api.sarvam.ai/*` and `wss://api.sarvam.ai/*`. Without these, Chrome MV3 blocks the Sarvam streaming WebSocket connection from the offscreen doc, silently falling back to batch STT and adding ~900ms per turn.
- Streaming WS error logging is now verbose: logs `key prefix/len` on open, logs the raw error/close events so Sarvam handshake failures (wrong key, server-side rejection) can be debugged from the offscreen devtools console and the Network tab.
- Added `streamer.stop() took Xms` log so latency improvements are directly measurable.
- Widget now keeps an in-memory `transcript[]` of finalized messages and exposes a **download button** in the header that serializes them to a timestamped `.txt` file.
- Widget: Go Live button added, PTT disabled while live, partial transcript bubble (dashed italic) updates during streaming, feed made `user-select: text` so conversation is copyable.

## Commands
```bash
npm run dev               # dev server (localhost:5173)
npm run dev -- --host     # LAN HTTPS
npm run build             # production build
vercel --prod             # deploy to production
```
