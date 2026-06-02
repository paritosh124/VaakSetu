# VaakSetu — Pivot Plan: Meeting Bot + PSTN Bridge

> Replacing the Chrome extension as the primary enterprise distribution channel.
> Extension is deprecated as a distribution path. Code preserved but not invested in further.

---

## Why This Pivot

The extension requires: Chrome install + virtual audio driver + system audio config + Meet audio config.
No bank IT team approves this. No call center agent sets this up.

The two new products are zero-install on the customer side and minimal-install for the agent.

---

## Product 1: Meeting Bot

### What It Does
A bot joins a Google Meet / Zoom call as a silent participant. It captures call audio
server-side, runs it through the translation pipeline, and streams translated audio
back to the agent's VaakSetu browser tab. The customer hears nothing different.
No extension. No virtual audio cable. Agent setup = open a browser tab.

### Technology: Recall.ai
- recall.ai provides APIs to join Meet/Zoom/Teams as a bot
- Bot receives real-time audio stream via webhook/websocket
- Bot can also inject audio into the call (for agent's translated speech)
- Pricing: ~$0.02/min bot time — acceptable, add to per-hour cost
- Alternatives if Recall.ai is too expensive: Livekit (self-hosted), Daily.co

### Architecture

```
Agent browser tab (VaakSetu)
  │
  ├─► POST /api/bot/create  ──► Recall.ai API ──► Bot joins Meet
  │                                                      │
  │                              audio stream (websocket)│
  │                                                      ▼
  │                              /api/bot/stream (Vercel Edge or separate server)
  │                                      │
  │                    customer speaks   │    agent speaks
  │                         ↓            │         ↓
  │                  Saaras/Groq STT     │   Saaras/Groq STT
  │                         ↓            │         ↓
  │                  Mayura/Llama        │   Mayura/Llama translate
  │                  translate           │         ↓
  │                         ↓            │   Google TTS
  │                  Google TTS          │         ↓
  │                         ↓            │   Recall.ai inject audio into call
  │                  stream to agent tab │   (customer hears translated agent)
  │                         ↓            │
  └──────────── agent hears translation ◄┘
```

### Agent UX
1. Agent is on Google Meet with a buyer
2. Opens VaakSetu tab → selects language pair → clicks "Start Translation"
3. VaakSetu bot joins the call (appears as "VaakSetu" in participant list)
4. Agent hears translated audio in VaakSetu tab via headphones
5. Agent speaks normally — bot captures, translates, injects into call for customer
6. Click "Stop" → bot leaves

### New Files to Build

```
api/
  bot/
    create.js         — POST: creates Recall.ai bot, returns botId
    status.js         — GET: bot status (joined/active/left)
    stop.js           — POST: removes bot from call
  bot-stream.js       — WebSocket relay: Recall.ai → translation pipeline → agent tab

src/
  MeetingBotPage.jsx  — Agent UI: language select, meeting URL input, start/stop
  api/bot.js          — Client-side API calls (create, stop, receive audio stream)
```

### Environment Variables Needed
```
RECALL_AI_API_KEY=
```

### Implementation Phases

**Phase 1 — Bot joins and transcribes (1 week)**
- Recall.ai account + API key
- `POST /api/bot/create` — sends meeting URL to Recall.ai, bot joins
- Receive real-time transcript via Recall.ai webhook
- Display transcript in agent UI (no translation yet)
- Validate: bot joins Meet, transcription works

**Phase 2 — Translation pipeline (3 days)**
- Wire Recall.ai audio stream → Saaras/Groq STT → Mayura/Llama → Google TTS
- Stream translated audio chunks to agent browser tab via WebSocket
- Agent hears translation in real time

**Phase 3 — Bidirectional (3 days)**
- Capture agent mic in browser
- Translate agent speech → inject via Recall.ai output audio API
- Customer hears agent in their language

**Phase 4 — UI + Polish (2 days)**
- Clean agent UI: language selectors, status indicator, transcript feed
- Handle bot disconnects, meeting end, errors
- Usage logging to Supabase

**Total estimate: ~2.5 weeks**

### Key Risks
- Recall.ai cost adds ~₹100/hr to pipeline cost — still well within margins
- Google Meet bot detection: Meet has tried to block bots; Recall.ai handles this
- Vercel serverless functions have 10s timeout — bot stream needs a persistent
  WebSocket server (use Vercel Edge Runtime or a small Railway/Fly.io server)
- Recall.ai is a US company — data residency concern for Indian banking clients;
  evaluate self-hosted Livekit alternative for those accounts

---

## Product 2: PSTN Bridge

### What It Does
Customer calls a regular Indian phone number (+91-XXXX-XXXXXX).
Call is routed through VaakSetu's server. VaakSetu translates in real time —
customer speaks Hindi, agent hears English; agent speaks English, customer hears Hindi.
Zero install on either side. Agent uses their existing phone or softphone.

### Technology: Exotel
- Exotel provides Indian virtual numbers + WebSocket audio streaming
- Well-supported in India, trusted by Indian enterprises
- Has passthru/applet API for real-time call audio access
- Fallback option: Twilio (more mature globally, pricier in India)

### Architecture

```
Customer dials +91-XXXX (Exotel virtual number)
        │
        ▼
Exotel receives call
        │
        ├─► WebSocket stream to /api/pstn/customer-stream
        │           │
        │    Saaras/Groq STT (customer language)
        │           │
        │    Mayura/Llama translate → agent language
        │           │
        │    Google TTS → audio
        │           │
        │    stream to agent softphone / VaakSetu agent tab
        │
        └─► bridge to agent leg (Exotel outbound call OR VoIP)

Agent speaks (via phone or VaakSetu browser tab)
        │
        ▼
/api/pstn/agent-stream
        │
    Groq Whisper STT
        │
    Mayura/Llama translate → customer language
        │
    Google TTS → audio
        │
    inject into Exotel customer leg
        │
Customer hears translated agent
```

### Two Agent Modes

**Mode A — Phone agent (simplest)**
- Exotel calls the agent on their regular phone
- Agent hears translated customer via their phone earpiece
- Agent speaks into phone → Exotel captures → VaakSetu translates → customer hears

**Mode B — Browser agent (better UX)**
- Agent logs into VaakSetu web dashboard
- Incoming calls appear in dashboard, agent accepts with one click
- Audio via WebRTC in browser — no phone needed
- Full transcript + analytics visible in real time

Start with Mode A (simpler), add Mode B in Phase 3.

### New Files to Build

```
api/
  pstn/
    inbound.js        — Exotel webhook: new call → set up translation session
    customer-audio.js — WebSocket: receive customer audio stream from Exotel
    agent-audio.js    — WebSocket: receive agent audio, translate, push to Exotel
    status.js         — call status updates from Exotel

src/
  PSTNDashboard.jsx   — Agent call dashboard: incoming calls, active sessions,
                        language pair config per number, transcript view
  api/pstn.js         — Client-side calls for dashboard
```

### Exotel Configuration
- Buy virtual number(s): one per language pair or one shared with IVR
- Configure "Exotel App" to point to `/api/pstn/inbound`
- Enable audio streaming passthrough to our WebSocket endpoint

### Environment Variables Needed
```
EXOTEL_API_KEY=
EXOTEL_API_TOKEN=
EXOTEL_SID=
EXOTEL_VIRTUAL_NUMBER=+91XXXXXXXXXX
```

### Implementation Phases

**Phase 1 — Receive inbound call + transcribe (1 week)**
- Exotel account + virtual number
- `/api/pstn/inbound` — receives Exotel webhook, responds with streaming config
- Receive customer audio stream via WebSocket
- Run through Saaras STT → get transcript
- Log to Supabase, display in dashboard
- Validate: call comes in, transcription works

**Phase 2 — One-way translation (3 days)**
- Customer audio → STT → translate → Google TTS
- Play translated audio back into the call via Exotel
- Agent hears translated customer on their phone (Mode A)
- Validate: agent can understand customer via translation

**Phase 3 — Bidirectional (1 week)**
- Capture agent audio (phone leg via Exotel, or browser mic)
- Translate agent speech → inject into customer leg
- Full two-way translated conversation

**Phase 4 — Browser agent UI (1 week)**
- Agent accepts calls in VaakSetu dashboard
- Real-time transcript both sides
- Post-call summary, download transcript
- Usage logged per call for billing

**Phase 5 — Multi-number + IVR (future)**
- Multiple virtual numbers for different language pairs
- IVR: "Press 1 for Hindi, 2 for Tamil" → routes to right translation config
- Org-level number management in dashboard

**Total estimate: ~4 weeks**

### Key Risks
- Exotel WebSocket audio streaming is less documented than Twilio Media Streams —
  may need support engagement; budget 1 week for initial integration friction
- Vercel serverless functions can't hold a persistent WebSocket for call duration —
  need a separate long-running server (Railway or Fly.io, ~$5-10/month)
- Audio codec: Exotel sends µ-law 8kHz; Saaras STT wants 16kHz PCM —
  need server-side resampling (Sox or ffmpeg)
- Latency budget: STT (~300ms) + translate (~400ms) + TTS (~500ms) = ~1.2s
  total delay. Acceptable for phone calls (WhatsApp voice has similar delay).
  Streaming STT will bring this to ~0.7s.

---

## Shared Infrastructure Needed (Both Products)

### Persistent WebSocket Server
Vercel serverless functions timeout at 10-30s. Both products need long-lived
connections for the duration of a call (minutes, not seconds).

**Recommended: Railway.app**
- Simple Node.js WebSocket server
- ~$5-10/month for a small instance
- Deploy: `railway up`
- Handles: Recall.ai audio relay + Exotel audio stream

```
src/server/
  index.js          — Express + ws WebSocket server
  bot-relay.js      — Recall.ai → translation → agent browser
  pstn-relay.js     — Exotel audio ↔ translation ↔ Exotel
  session.js        — in-memory session state (botId, callSid, language pairs)
```

### Supabase Tables Needed
```sql
-- For Meeting Bot
create table bot_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organisations(id),
  recall_bot_id text,
  meeting_url text,
  source_lang text,
  target_lang text,
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_seconds int,
  transcript jsonb
);

-- For PSTN Bridge
create table pstn_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references organisations(id),
  exotel_call_sid text,
  virtual_number text,
  customer_lang text,
  agent_lang text,
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_seconds int,
  transcript jsonb,
  recording_url text
);
```

---

## Build Order Recommendation

```
Week 1-2:   Meeting Bot Phase 1+2  (bot joins, one-way translation working)
Week 3:     Meeting Bot Phase 3+4  (bidirectional + UI polish)
Week 4-5:   PSTN Bridge Phase 1+2  (inbound call + one-way translation)
Week 6-7:   PSTN Bridge Phase 3+4  (bidirectional + browser dashboard)
Week 8:     Both products: billing integration, usage caps, org management
```

Start with Meeting Bot because:
- Recall.ai is easier to integrate than Exotel (better docs, REST API first)
- Export businesses (primary target) are on video calls, not phone-only
- Faster time to first demo — show a customer on week 2

---

## What Happens to the Extension

- Keep codebase, don't delete
- Remove from active marketing / landing page (or move to "advanced users" section)
- No further feature investment
- May revisit if a specific customer requests it (some IT environments allow extensions)

---

## Success Metrics

| Milestone | Target |
|---|---|
| Meeting bot joins and transcribes | Week 2 |
| First live demo with a real customer | Week 3 |
| PSTN bridge receives and translates inbound call | Week 5 |
| First paying customer on either product | Week 8 |
| 3 paying customers | Week 12 |
