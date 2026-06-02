# VaakSetu Relay Server

Persistent WebSocket relay for the **Meeting Bot** (and later the PSTN Bridge).
Vercel serverless functions time out in seconds and can't hold a call-length
socket — this small Node process does. Deployed **separately** from the Vercel
frontend.

## Why separate

`src/pipeline.js` and `src/api/*` are browser-targeted (`import.meta.env`,
`AudioContext`, `MediaRecorder`). This server re-implements only the data
transforms in `pipeline-node.js`, calling Sarvam / Groq / Google directly with
server-side keys.

## Run locally

```bash
cd src/server
npm install
# export the env vars below (or use a .env loader)
npm run dev        # node --watch index.js
curl localhost:8080/health
```

## Deploy — Render free tier (POC)

1. New → Web Service → connect the repo.
2. Root directory: `src/server`. Build: `npm install`. Start: `npm start`.
3. Add the env vars below.
4. Note the public URL → set it as `BOT_RELAY_WS_URL` (as `wss://…`) and
   `BOT_RELAY_HTTP_URL` (as `https://…`) in the Vercel project env.

> Free tier spins down after 15 min idle → first connect pays a ~30–60s cold
> start. The frontend wakes it via `GET /health` before creating a bot (see
> MEETING_BOT_PLAN.md §2.1). Upgrade to Render paid / Fly.io for no-sleep prod.

## Environment variables

```
PORT                       # provided by Render; defaults to 8080 locally
SARVAM_API_KEY             # Indian STT/translate/TTS
GROQ_API_KEY               # intl STT + translate
GOOGLE_TTS_API_KEY         # intl TTS
RECALL_AI_API_KEY          # output-audio injection into the meeting
RECALL_API_BASE            # optional; defaults to documented US base
SUPABASE_URL               # optional; for bot_sessions + usage logging
SUPABASE_SERVICE_ROLE_KEY  # optional; service-role insert
RELAY_SHARED_SECRET        # shared with Vercel api/bot/* to guard /sessions
```

## Endpoints

- `GET  /health` — wake + liveness. `{ ok, activeSessions, ts }`.
- `POST /sessions` — register a session (called by `api/bot/create.js`).
  Body: `{ sessionId, botId, orgId, userId, meetingUrl, agentLang, customerLang, agentVoice, customerVoice }`.
  Header: `x-relay-secret: <RELAY_SHARED_SECRET>`.
- `POST /sessions/:id/end` — tear down + persist transcript.
- `WS   /agent?sessionId=…`  — browser agent socket.
- `WS   /recall?sessionId=…` — Recall.ai audio stream. ⚠️ PHASE-0: confirm direction/format.

## ⚠️ PHASE-0 TODO (blocks the Recall paths)

The Recall.ai wire formats are best-guesses from the docs. Confirm against the
live API before relying on the customer-audio-in / agent-audio-out paths:
`recall.js` (output audio), `bot-relay.js` `attachRecallSocket` (inbound frame
shape), and `index.js` upgrade routing (does Recall connect to us, or we to
them?). See MEETING_BOT_PLAN.md §1.
