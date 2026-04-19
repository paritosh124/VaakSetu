# CLAUDE.md — Project Context for VaakSetu

## What is VaakSetu?
VaakSetu (वाक् + सेतु = Voice Bridge) is a bidirectional real-time voice translator for Indian languages. Two people who don't speak each other's language share one device, take turns pressing hold-to-talk buttons, and hear translations spoken aloud.

## Tech Stack
- **Frontend:** React + Vite (single-page app)
- **APIs:** Sarvam AI (all three models below)
- **Hosting:** Local dev with Vite proxy; planned Vercel deployment

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

## Current Language Pairs (MVP)
- Hindi ↔ Telugu
- English ↔ Telugu

## Project Structure
```
src/
  App.jsx          — Main UI component (setup screen, conversation feed, hold-to-talk buttons)
  pipeline.js      — Orchestrates STT → Translate → TTS pipeline
  api/sarvam.js    — Wrapper for all Sarvam API calls
  main.jsx         — React entry point
index.html         — HTML entry with fonts (Crimson Pro + DM Sans)
vite.config.js     — Vite config with dev proxy (/sarvam → api.sarvam.ai)
.env               — VITE_SARVAM_API_KEY (not committed)
```

## Key Implementation Details

### API Configuration
- Dev proxy in vite.config.js: `/sarvam/*` → `https://api.sarvam.ai/*` (avoids CORS)
- API key stored in `.env` as `VITE_SARVAM_API_KEY` and also in localStorage
- Header: `api-subscription-key: <key>`

### Sarvam API Gotchas (already resolved)
- Bulbul v3 does NOT support `loudness` or `pitch` parameters — omit them
- Speaker names must be **lowercase** (e.g., `anand`, `ritu`, not `Anand`)
- Available speakers: anushka, abhilash, manisha, vidya, arya, karun, hitesh, aditya, ritu, priya, neha, rahul, pooja, rohan, simran, kavya, amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa, kabir, aayan, shubh, ashutosh, advait, anand, tanya, tarun, sunny, mani, gokul, vijay, shruti, suhani, mohit, kavitha, rehan, soham, rupali
- Currently using: Person A → `anand`, Person B → `ritu`

### Audio Recording
- Uses MediaRecorder API (browser native)
- Records in `audio/webm` format
- Minimum blob size check (1000 bytes) to reject accidental taps

### UI Design
- Dark theme: deep indigo (#0C0B1A) background
- Person A accent: amber (#F5A623)
- Person B accent: teal (#0FB8A9)
- Fonts: Crimson Pro (headers), DM Sans (body)
- Hold-to-talk buttons with pulse ring animation while recording

## Features Implemented
- [x] Hold-to-talk recording (Person A / Person B)
- [x] Full STT → Translate → TTS pipeline
- [x] Language pair selector (Hindi↔Telugu, English↔Telugu)
- [x] Conversation feed with message bubbles
- [x] English pivot text shown as secondary transcript
- [x] Auto-scroll to latest message
- [x] API key setup screen with localStorage persistence
- [x] Error handling and display
- [x] Replay button on each message bubble (plays stored TTS audio)
- [x] Processing status indicator with step icons

## Planned Enhancements
- [ ] Deploy to Vercel (needs API proxy route for CORS in production)
- [ ] Mobile access (currently blocked by firewall/CORS on local dev)
- [ ] Add more language pairs (Kannada, Malayalam, Marathi)
- [ ] Auto-detect language (remove fixed pair selector)
- [ ] Live waveform visualizer during recording
- [ ] Clear conversation / reset button
- [ ] Copy transcript text
- [ ] Latency timer per message
- [ ] Light/dark mode toggle
- [ ] Mute TTS (text-only mode)
- [ ] Offline fallback for common phrases

## Latency Considerations
- No streaming support on any Sarvam API (all request/response)
- Typical end-to-end: ~2-3 seconds for 3-call path, ~1.5-2s for 2-call path
- Optimizations applied: pipeline fires next call immediately when previous returns
- Future: pre-warm HTTP connections on button press, stream TTS audio playback

## Commands
```bash
npm run dev          # Start dev server (localhost:5173)
npm run dev -- --host  # Expose to network (for mobile testing)
npm run build        # Production build
```
