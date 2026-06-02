# Meeting Bot — Detailed Implementation Plan

> Engineering drill-down for Product 1 of `pivot_plan.md`. Covers the shared
> persistent WebSocket server (needed by both Meeting Bot and PSTN Bridge) and
> the Recall.ai integration. PSTN Bridge stays at the `pivot_plan.md` level until
> Meeting Bot is demoable.

---

## ⚠️ TRANSPORT CHANGED: Recall.ai → LiveKit (2026-06-01)

Recall.ai requires a business email (domain + paid mailbox) — not worth it for
validation. **Switched to LiveKit (Cloud free tier).** This changes the product
model: instead of a bot joining the customer's *existing* Google Meet, the
**customer joins a VaakSetu room link** (`/room.html`) in their browser — no
install. The relay joins that LiveKit room as a server-side participant
("vaaksetu-translator"), subscribes to the customer's mic, and publishes the
agent's translated speech back. **The agent side is unchanged** (agent ↔ relay
over our own WebSocket; the agent is NOT in the LiveKit room).

The Recall-specific sections below (§1 spike, §4 `api/bot` Recall shapes, §0
"mute in Meet") are **superseded** — kept for history. There is no Recall spike
to do; LiveKit's contract is known and the media code is written.

### Built (LiveKit version) — builds clean

- `src/server/` relay: `index.js` (Express+ws, `/health`, keep-alive, session
  register → joins LiveKit room), `config.js`, `pipeline-node.js` (Node STT/
  translate/TTS — agent→customer TTS uses LINEAR16/WAV so it's injectable),
  `session.js`, `vad.js` (segments the customer PCM), `audio.js` (WAV parse +
  resampler, no native dep), **`livekit.js`** (server participant: subscribe
  customer mic → 16 kHz PCM; `inject(wav)` publishes TTS into the room),
  `bot-relay.js` (serial turn queue + feedback guard), `Dockerfile`, `README.md`.
- `api/bot/create.js` (mints customer LiveKit token + registers session) and
  `api/bot/stop.js`, behind `withAuth`. (`status.js` removed — status flows over
  the agent WS.)
- `src/api/bot.js`, `src/MeetingBotPage.jsx` (`/meeting`: pick langs → Start →
  shareable customer link + §2.1 status + push-to-talk), `public/room.html`
  (customer page, CDN `livekit-client`, no build dep).
- `supabase/migrations/20260601000000_bot_sessions.sql` (`room_name`).

### First-run caveats (can't test without LiveKit creds + native install)
- `@livekit/rtc-node` export names / `AudioFrame` ctor signature may differ by
  version — verify in `livekit.js` on first deploy.
- Inject un-mute timing is a length-based estimate (inject resolves when frames
  are queued, not when playback ends) — may need tuning.
- Agent mic is push-to-talk; hands-free VAD is a Phase-3 follow-up.

### Env vars (LiveKit version)
- Vercel: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
  `BOT_RELAY_HTTP_URL`, `RELAY_SHARED_SECRET`, `WEBAPP_URL`,
  `VITE_BOT_RELAY_HTTP_URL`, `VITE_BOT_RELAY_WS_URL`.
- Relay (Render): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
  `SARVAM_API_KEY`, `GROQ_API_KEY`, `GOOGLE_TTS_API_KEY`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `RELAY_SHARED_SECRET`.

> `livekit-server-sdk` added to root `package.json` (used only in `api/`, not
> bundled by Vite). The relay's `@livekit/rtc-node` + `livekit-server-sdk` are
> in `src/server/package.json`, installed on the relay host.

---

## 0. Agent UX model (decides the whole architecture)

The cleanest flow that avoids per-participant audio separation:

1. Agent joins the Google Meet with the customer as normal.
2. Agent **mutes themselves inside Meet** and speaks only into the VaakSetu tab.
3. Agent opens `vaak-setu.vercel.app/meeting`, pastes the Meet URL, picks the
   language pair (e.g. agent=English, customer=Hindi), clicks **Start**.
4. VaakSetu's bot joins the Meet (shows as "VaakSetu" in the participant list).

Resulting audio routing:

```
Customer speaks (Hindi) ─► bot captures Meet audio ─► server STT(hi→en)
                                                        ─► stream English text + TTS
                                                        ─► agent's VaakSetu tab (headphones)

Agent speaks (English) ─► VaakSetu tab mic ─► server STT(en) ─► translate en→hi
                                              ─► Google/Bulbul TTS
                                              ─► Recall.ai output-audio ─► injected into Meet
                                              ─► customer hears Hindi
```

**Why this works without per-participant separation:** because the agent is
muted *inside Meet* and speaks only through VaakSetu, the only human voice in
the Meet's mixed audio is the customer. So `audio_mixed_raw` from Recall = the
customer. We never have to demux speakers.

> Trade-off to confirm with a real user: the agent must remember to mute in
> Meet. If they forget, the customer hears raw English + translated Hindi. A
> later refinement can use Recall's per-participant audio (`audio_separate_raw`)
> to filter to non-agent speakers, but that's a Phase 5 nicety, not MVP.

---

## 1. Phase 0 — Recall.ai API spike (do this BEFORE writing the relay) ⚠️

The relay design hinges on exact contracts that the docs describe loosely.
Spend ~half a day confirming, because guessing wrong reshapes the server:

- [ ] **Real-time audio IN**: confirm `recording_config.realtime_endpoints`
      with a `websocket` endpoint + which event delivers raw audio
      (`audio_mixed_raw.data` vs per-participant `audio_separate_raw.data`).
      Confirm the wire format Recall pushes: encoding (PCM s16le?), sample rate
      (16 kHz? 48 kHz?), channels, framing (JSON-with-base64 vs protobuf vs raw
      binary frames), and whether Recall *connects to our* WSS or expects us to
      connect to theirs.
- [ ] **Real-time audio OUT (inject agent speech)**: confirm the mechanism.
      Options seen historically: (a) `POST /api/v1/bot/{id}/output_audio/` with
      a hosted file / base64 clip (higher latency, simplest), (b) streaming
      "Output Media" over a websocket (lower latency, beta). Decide MVP path —
      probably (a) first, measure latency, upgrade to (b) if too slow.
- [ ] **Bot lifecycle webhooks**: events for `joining`, `in_call_recording`,
      `done`, `error`, and how status is polled (`GET /api/v1/bot/{id}`).
- [ ] **Auth + region**: API key header format; confirm whether there's an
      India/EU region option (data-residency note for banking clients).
- [ ] **Pricing sanity check**: confirm ~$0.02–0.03/min bot time against current
      Recall pricing so the ₹/hr margin in `project_stack.md` still holds.

Deliverable of Phase 0: a 1-page note appended to this file ("Recall.ai
confirmed contract") with the real formats. Everything below assumes the
*likely* shape and is marked where it depends on the spike.

---

## 2. Shared persistent WebSocket server (`src/server/`)

Vercel functions time out at 10–30s and can't hold a call-length socket. Both
products run on one small long-lived Node server.

**Host (POC): Render free tier.** Zero cost while developing. A free Render web
service spins down after 15 min of *no inbound traffic*. Important nuance: an
**active call keeps the socket busy, so it never sleeps mid-call** — a ~30s
keep-alive ping makes this bulletproof. What sleeps is the server *between*
sessions, so the first connect after an idle period pays a **cold start**
(~30–60s to boot the container) before it accepts the connection. We handle that
explicitly (see §2.1) rather than letting the agent stare at a hung Start button.

**Host (production upgrade): Render paid (~$7/mo, no sleep) or Fly.io.** One-line
`BOT_RELAY_WS_URL` env change — no code rewrite. The server is host-agnostic.

### Files

```
src/server/
  index.js          — Express + ws bootstrap; health check; mounts relays
  bot-relay.js      — Recall.ai audio IN ↔ pipeline ↔ agent browser; audio OUT
  session.js        — in-memory session registry (sessionId → {botId, langs, sockets})
  pipeline-node.js  — Node-side pipeline calls (see §3 — no browser APIs)
  config.js         — env, API base, model IDs
  package.json      — server-only deps (express, ws, node-fetch if needed)
  Dockerfile        — for Railway/Fly (or nixpacks auto-detect)
  README.md         — deploy + env instructions
```

> Keep `src/server/` as its own npm workspace or at least its own
> `package.json` so the Vite client bundle never pulls in `express`/`ws`. The
> server is deployed separately from the Vercel frontend.

### Responsibilities of `bot-relay.js`

- Accept the inbound audio stream for a session (from Recall per the Phase-0
  contract). Buffer per-utterance using **VAD** (port the energy-VAD logic from
  the extension's `createVadLoop` / webapp `startSilenceDetection`; thresholds
  already tuned: `SILENCE_MS≈700`, gap-tolerant accumulator).
- On utterance end → run customer STT→translate→TTS, push **English transcript
  text** + **translated audio** down the agent's browser WebSocket.
- Accept the agent's mic audio (from the browser WS), VAD-segment it, run
  STT→translate(en→customerLang)→TTS, and call Recall's output-audio to inject
  it into the Meet.
- Serial turn queue per session (reuse the extension's `pumpQueue` pattern) so
  overlapping speech doesn't garble playback; pause the opposite side's
  intake during injection to avoid feedback.

### 2.1 Cold-start handling (Render free) — server + client

The whole point is the agent never sees a silent hang. Build the wake/retry/
status machinery up front so the free tier is transparent:

**Server (`src/server/index.js`)**
- `GET /health` → returns `200 {ok:true}` immediately. This is the wake target —
  the first hit boots the container; subsequent hits are instant. Cheap enough
  that the client can poll it.
- Keep-alive: ws server sends a ping frame every ~25–30s on every open socket
  (and the agent client pings back) so a long quiet stretch within a live call
  never counts as "no inbound traffic." Belt-and-suspenders against the 15-min
  spin-down.

**Client (`src/api/bot.js` + `MeetingBotPage.jsx`) — wake-then-connect flow**
1. On Start, *first* call `wakeRelay()`: `GET {BOT_RELAY_WS_URL}/health` with a
   short timeout, retrying with backoff (e.g. 3s → 5s → 8s, up to ~75s total) to
   cover the ~30–60s cold boot. Surface progress as status the whole time.
2. Only after `/health` returns 200 do we `POST /api/bot/create` and open the
   session WebSocket. This guarantees the relay is warm before Recall and the
   agent both try to connect to it.
3. If `/health` never comes up in the window → status `error` with a "server
   waking up, tap Retry" message and a Retry button (re-runs the wake flow).
4. Optional polish: fire a fire-and-forget `wakeRelay()` as soon as the
   `/meeting` page mounts, so by the time the agent fills in the URL + langs and
   clicks Start, the server is usually already warm and Start feels instant.

**Status states surfaced in the UI (status pill, see §6):**

```
idle            → "Ready"
waking          → "Waking translation server… (free tier cold start, up to ~1 min)"
                  with an elapsed-seconds counter so it doesn't feel frozen
creating-bot    → "VaakSetu is joining the meeting…"
bot-joining     → "Waiting for the bot to be admitted…"   (Recall status: joining)
live            → "● Live — translating"
reconnecting    → "Connection dropped, reconnecting…"     (auto-retry the WS)
error           → "<reason>"  + Retry button
ended           → "Session ended"
```

Status is driven by: the wake poll, Recall lifecycle webhooks/polling (§4), and
the relay WS connection state. Render the pill prominently — on the free tier the
`waking` state is the agent's main feedback that things are working, not broken.

### `session.js`

In-memory `Map<sessionId, Session>`. A `Session` holds `botId`, `agentLang`,
`customerLang`, voice prefs, the agent browser socket, the Recall audio socket,
the turn queue, and timers. Cleaned up on bot `done`/`error` or agent
disconnect. (No persistence here — durable records go to Supabase, §5.)

---

## 3. Pipeline reuse — the Node port problem

`src/pipeline.js` + `src/api/*.js` are **browser-targeted**: they use
`import.meta.env`, `fetch` to relative `/api/*` proxy paths, `AudioContext`,
`MediaRecorder`, `decodeAudioData`. None of that exists in Node.

Plan: create `src/server/pipeline-node.js` that reimplements only the **data
transforms** (STT → translate → TTS as text/bytes in, base64/bytes out) by
calling the upstream APIs directly (Sarvam, Groq, Google TTS) with server-side
keys — *not* through the Vercel `/api/*` proxies (avoids an extra hop and the
10s function limit). It must NOT touch any Web Audio API; audio is just bytes
relayed to the browser, which decodes/plays it.

Stages to port (mirroring the existing hybrid engine choice in `CLAUDE.md`):

- STT: Sarvam Saaras WS/batch for Indian source; Groq Whisper for intl.
- Translate: Mayura (`formal` mode) for Indian target; Groq Llama 70B for intl.
- TTS: Bulbul for Indian target; Google Cloud TTS for intl.

Keep the env-key reads server-side (`SARVAM_API_KEY`, `GROQ_API_KEY`,
`GOOGLE_TTS_API_KEY`) — same vars the Vercel functions already use, now also set
on Railway.

> Audio codec note: whatever sample rate Recall delivers (Phase 0) likely needs
> resampling to 16 kHz mono PCM for Saaras. Budget a small resampler
> (`sox`/`ffmpeg` child process, or a pure-JS resampler). Same concern reused
> by PSTN (Exotel µ-law 8 kHz).

---

## 4. Vercel control-plane endpoints (`api/bot/`)

These are short request/response calls (fit the serverless model fine) and stay
on Vercel behind `withAuth`. They orchestrate Recall and hand the agent a
sessionId + the server WS URL.

```
api/bot/
  create.js   — POST {meetingUrl, agentLang, customerLang, voices}
                → calls Recall create-bot with realtime_endpoints pointing at
                  the Railway server's WSS, registers a session, returns
                  {sessionId, botId, wsUrl}
  status.js   — GET ?botId= → proxies Recall GET bot status
  stop.js     — POST {botId} → Recall "leave call"; tears down session
```

- All three wrapped in `withAuth` (from `api/_auth.js`) → enforce signed-in
  user, attach `org_id`, and `logUsage` for billing.
- New env var: `RECALL_AI_API_KEY` (Vercel + Railway). Plus
  `RECALL_REGION` if Phase 0 finds a non-US option.
- The Railway server WSS base URL becomes a new env: `BOT_RELAY_WS_URL`
  (e.g. `wss://vaaksetu-relay.up.railway.app`). `create.js` passes a
  per-session path/token so Recall and the agent connect to the right session.

---

## 5. Supabase

Add the `bot_sessions` table from `pivot_plan.md` (org_id FK, recall_bot_id,
meeting_url, langs, started/ended, duration, transcript jsonb). RLS: rows scoped
to the user's `org_id` (mirror existing `usage_events`/`profiles` policy style).
The Railway server writes session rows via the service-role key (same pattern as
`api/_auth.js`'s `adminClient`).

---

## 6. Frontend (`src/MeetingBotPage.jsx` + `src/api/bot.js`)

- Add route `/meeting` to the router in `src/main.jsx` (wrapped in
  `CodeGate`+`AuthGate`+`AuthBadge` like `/app`).
- `MeetingBotPage.jsx`: meeting-URL input, agent/customer language selectors
  (reuse the dropdown + 🇮🇳/🌍 toggle components from `App.jsx`), voice toggles,
  Start/Stop, a **status pill driven by the §2.1 state machine** (idle → waking →
  creating-bot → bot-joining → live → reconnecting/error/ended), and a live
  transcript feed (reuse the message-bubble + auto-scroll UI from `App.jsx`).
- On Start: `authedFetch('/api/bot/create')` → get `{sessionId, wsUrl}` →
  open browser WebSocket to the relay → start capturing agent mic
  (`getUserMedia`, reuse iOS-safe gesture handling) and stream to relay →
  receive customer transcript text + translated audio, decode via the existing
  `playBase64Audio` path in `src/api/sarvam.js`.
- On Stop: close WS, stop mic, `authedFetch('/api/bot/stop')`.
- `src/api/bot.js`: thin client wrappers (create/status/stop) using
  `authedFetch` from `src/lib/authed-fetch.js`.
- Clear in-tab instruction banner: **"Mute yourself in Meet — speak only here."**

---

## 7. Build order & checklist

**Phase 0 — Recall spike (~0.5 day)** → confirm audio in/out contract. ⚠️ gate.

**Phase 1 — Bot joins + transcribes (~1 wk)**
- [ ] Scaffold `src/server/` (index + health), deploy empty to Railway, confirm reachable.
- [ ] `api/bot/create|status|stop.js` behind `withAuth`; `RECALL_AI_API_KEY` set.
- [ ] Recall bot joins a real Meet from a `create` call; status polling works.
- [ ] Relay receives customer audio; `pipeline-node.js` STT only → push text to agent WS.
- [ ] Minimal `MeetingBotPage.jsx` showing live English transcript. **Demo gate.**

**Phase 2 — One-way translation + playback (~3 days)**
- [ ] Wire translate + TTS in `pipeline-node.js`; stream translated audio to agent tab.
- [ ] Agent hears translated customer in headphones. VAD-segmented turns, serial queue.

**Phase 3 — Bidirectional (~3 days)**
- [ ] Capture agent mic in browser, stream to relay.
- [ ] Translate agent→customer lang, inject via Recall output-audio. Feedback-pause logic.

**Phase 4 — Polish (~2 days)**
- [ ] Status/error handling (bot disconnect, meeting end), reconnect.
- [ ] `bot_sessions` Supabase logging + duration for billing; `logUsage`.
- [ ] UI cleanup, mute-reminder banner, transcript download (reuse widget's serializer).

---

## 8. Key risks (from pivot_plan, made concrete)

- **Recall output-audio latency** — if file/base64 inject is too slow for
  conversation, need streaming Output Media (beta). Measure in Phase 3.
- **Persistent server** — Render free tier spins down after 15 min idle → cold
  start. Mitigated by the §2.1 wake-on-/health flow + keep-alive ping; an active
  call never sleeps. Upgrade to Render paid / Fly.io for production (no sleep).
  Single instance = no horizontal scaling yet (fine for first customers; revisit
  with a session-affinity load balancer later).
- **Data residency** — Recall is US-based. For banking accounts, evaluate
  self-hosted LiveKit as a drop-in for the audio-transport layer (the relay +
  pipeline stay the same; only the "bot joins call" provider swaps).
- **Codec/resampling** — confirmed in Phase 0; shared with PSTN.
- **Supabase free-tier pausing** (known issue) — relay's service-role writes
  fail when the project sleeps; same monitoring need as today.

---

## 9. New environment variables

```
# Vercel (control plane) + Railway (relay) — both
RECALL_AI_API_KEY=
BOT_RELAY_WS_URL=wss://<railway-host>      # Vercel needs it to tell Recall+agent where to connect
SARVAM_API_KEY= GROQ_API_KEY= GOOGLE_TTS_API_KEY=   # already exist; replicate onto Railway
SUPABASE_URL= SUPABASE_SERVICE_ROLE_KEY=            # replicate onto Railway for session logging
```
