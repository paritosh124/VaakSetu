# VaakSetu — Implementation Reference
> Conversation distilled on 29 May 2026. Use this as a living reference when moving from part-time exploration to active implementation.

---

## 1. Project Context

**What VaakSetu is:**
Real-time bidirectional voice translator for Indian and international languages. Two people who don't share a language hold a live conversation — each hears the other in their own language with ~0.9–2.5s latency.

**Live app:** https://vaak-setu.vercel.app  
**Repo:** https://github.com/paritosh124/VaakSetu  
**Current stack:** React + Vite, Vercel (Mumbai `bom1`), Sarvam AI (STT + translate + TTS), Groq + ElevenLabs (international), PeerJS WebRTC, Supabase auth.

---

## 2. Current Capabilities (Already Built)

| Feature | Status |
|---|---|
| Hold-to-speak solo mode (1 device, 2 people) | ✅ Done |
| Two-phone WebRTC mode (PeerJS, room codes) | ✅ Done |
| Go Live hands-free VAD mode | ✅ Done |
| Sarvam streaming STT (AudioWorklet → 16kHz PCM → WSS) | ✅ Done |
| Sarvam pipeline: Saaras v3 → Mayura v1 → Bulbul v3 | ✅ Done |
| Groq + ElevenLabs pipeline (international languages) | ✅ Done |
| OpenAI pipeline (fallback) | ✅ Done |
| Chrome MV3 extension (call-center overlay) | ✅ Done |
| Supabase auth wired to extension | ✅ Done |
| 11 Indian + 18 international languages | ✅ Done |
| Vercel serverless API proxy (keys not exposed) | ✅ Done |

**What's NOT built yet:**
- PSTN telephony bridge (Exotel/Telnyx integration)
- REST + WebSocket API for third-party developers
- Admin/usage dashboard
- Security layer (BYOK, audit logs, DPA)
- Company registration

---

## 3. Validated Problem Statement

**Source:** Casual conversation with a PSU bank branch manager (North India).

**The problem:**  
Branch managers in Hindi-speaking states (UP, Delhi, Rajasthan) frequently need to communicate with:
- Zonal head offices in Chennai/Hyderabad (Tamil/Telugu)
- Police/legal authorities in South India
- RBI regional offices across language zones

**Consequence:** A simple problem that should resolve in 1 day was taking ~1 week due to language friction, causing customer dissatisfaction and compliance delays.

**Why no solution exists at scale:**
- Observe.ai, Sanas, Intent.ai = post-call analytics or accent softening — not real-time multilingual translation
- Google Translate = text only, not voice-native
- Human interpreters = expensive, not available on-demand for routine calls

---

## 4. Target Market — BFSI First

### Primary Vertical: PSU Banking
**Why:**
- Pan-India presence with deliberate regional language mismatches (head offices in South, branches in North)
- Quantifiable pain: 1-week delays = measurable staff cost + customer churn + compliance risk
- RBI financial inclusion push → more branches in linguistically diverse areas = problem gets worse, not better
- Once a vendor, sticky for years

**Secondary verticals (after banking validation):**
- Hospitals / telemedicine (doctor ↔ patient language mismatch)
- Insurance / NBFC (outbound loan/recovery calls)
- Courts / legal (regional language documentation)
- Government last-mile services (ASHA workers, gram panchayat)

### Who Feels the Pain vs Who Pays
| Role | Relationship |
|---|---|
| Branch manager | Feels the pain daily — your champion |
| IT / COO office | Makes purchasing decision — your buyer |
| Compliance team | Signs off on security — your gatekeeper |

**Key insight:** The branch manager will never be your buyer. Use him/her to get to the buyer.

---

## 5. Product Strategy — Phased Build

### Phase 1: PSTN Telephony Bridge (Build Now)
**What it is:**  
Both parties dial one virtual number. The system intercepts live audio from each call leg, runs it through the translation pipeline, and plays translated audio back to each party. No app install. No behavior change.

**How it works technically:**
1. Both callers dial a virtual number (Exotel or Telnyx)
2. Telephony SDK delivers live audio streams from both legs to your server
3. Audio from Person A → Sarvam Saaras (STT) → Mayura (translate) → Bulbul (TTS) → played to Person B
4. Same in reverse simultaneously
5. Full transcript logged with timestamps, both language versions

**Technical additions needed on top of existing VaakSetu:**
- Exotel streaming API integration (or Telnyx WebSocket media streams) to receive/send PSTN audio
- Session manager holding two call legs open and routing audio through existing pipeline
- Simple admin dashboard: call history, duration, languages, cost per call

**Estimated build time (solo, part-time):** 3–4 focused weekends for MVP, 2–3 months for production-ready

**Telephony provider options for India:**
- **Exotel** — Indian provider, has streaming API, good PSTN coverage, startup-friendly pricing
- **Telnyx** — WebSocket media streams, more developer-friendly API, has India numbers
- **Twilio** — well-documented but more expensive; good fallback

**Latency reality:**
- Current pipeline: ~0.9s (streaming STT) to ~2.5s (batch)
- On a phone call this creates unnatural pauses — must be communicated upfront to users
- Mitigation: push-to-talk discipline or audio cue ("translating…") during gap
- Key framing: even 2.5s delay is vastly better than a 1-week resolution time

### Phase 2: API / SDK Channel (3–6 Months After Phase 1)
**What it unlocks:**  
Other product builders embed translation into their own workflows. Becomes platform/infrastructure play.

**Target API buyers:**
- Dialer SaaS companies (Exotel, Ozonetel, Freshcaller, LeadSquared) — add multilingual toggle to their dashboard, powered by your API. They become your distribution.
- Telecalling fintechs (CreditSaison, Kissht, NBFCs doing multilingual outbound)
- Health-tech platforms (Practo, mFine, eSanjeevani — doctor/patient language mismatch)

**API product shape:**
- **REST endpoint:** POST audio or text + language pair → receive translated audio. For async use cases (voicemail, recorded call, WhatsApp voice note translation).
- **WebSocket endpoint:** Live bidirectional streaming for real-time calls. Dialer SDK connects both legs, audio flows in, translated audio flows out.
- **Developer dashboard:** API key management, usage tracking, spending limits, sandbox mode
- **Documentation:** Code samples in Python, Node.js, and curl minimum

**Revenue model:** Per-1000 API calls or per-minute wholesale pricing. Dialer companies mark up to their customers.

### Phase 3: Consumer App (Later — Don't Build Now)
WhatsApp-style VoIP with translation. Deferred because:
- Requires both parties to install a new app
- WhatsApp already owns free VoIP — hard to displace
- Consumer acquisition is expensive and slow
- Makes sense only after brand recognition from B2B success

---

## 6. Pricing Model

### Option A: Per-Minute Consumption
- Charge ₹8–15 per translated minute
- Easy to sell (no upfront commitment)
- Problem: lumpy revenue, banks under-use in early months

### Option B: Monthly Branch License (Recommended for Phase 1)
- ₹3,000–8,000 per branch per month (unlimited calls)
- Fixed operational line item = easy for bank to budget
- ROI argument: one avoided week-long delay = 2–3 months of subscription fees

### Option C: Enterprise Annual Contract (Phase 2+)
- ₹15–40 lakh per year for mid-sized PSU bank
- Requires reference customers first

### Recommended Path:
1. **Start per-minute** for first 2–3 pilot customers — removes friction, generates usage data
2. Use real usage data to construct flat monthly price that's attractive to buyer but healthy for you
3. Move to annual contracts once you have 3+ happy customers

### Unit Economics (reference numbers):
- Cost of a 5-minute translated call: ~₹3–6 (Sarvam API) + ~₹1–2 (telephony) = ₹4–8 total
- Revenue at ₹10/min for 5 min call: ₹50
- Gross margin: ~60–80% depending on call volume
- At 5 calls/week × 5 min × 4.3 weeks = ~107 minutes/branch/month
- ₹4,000 flat fee / 107 minutes = ₹37/minute effective rate — very healthy margin
- Break-even for bank: avoided even 1 week-long delay per month justifies the fee

---

## 7. Security Requirements (For Banking Clients)

These will be asked before any contract is signed. Prepare answers in advance.

### Must-Have for Pilot
- [ ] TLS everywhere, WSS for streaming (already done)
- [ ] Confirm Sarvam AI data processing happens within India — get this in writing from Sarvam
- [ ] NDA signed before any pilot begins
- [ ] Written security roadmap (shows bank you've thought about it)
- [ ] Data Processing Agreement (DPA) template ready to present

### Must-Have for Production Contract
- [ ] Data residency confirmed: audio and transcripts stored in Indian data center (AWS Mumbai or Azure India Central)
- [ ] Encryption at rest: AES-256
- [ ] Access controls: strict role-based, audit trail of who accessed what
- [ ] Configurable retention periods + automatic deletion
- [ ] BYOK (Bring Your Own Key): bank holds encryption keys, VaakSetu cannot read call content
- [ ] Zero-access architecture for call content beyond milliseconds needed for translation
- [ ] ISO 27001 certification (put on roadmap — banks love this checkbox)

### RBI Compliance Note
RBI has data localization requirements for financial data. Sarvam AI processes the audio — verify their data residency posture before any bank conversation. This is a blocking item.

**Estimated engineering time for full security layer:** 6–8 weeks dedicated work.

---

## 8. Competitive Landscape

| Company | What they do | Gap VaakSetu fills |
|---|---|---|
| Observe.ai | Post-call analytics, coaching | Not real-time, not multilingual translation |
| Sanas | Real-time accent softening | Same language, not translation |
| Intent.ai | Call center AI analytics | Not translation |
| Google Translate | Text translation | Not voice-native, not real-time call integration |
| Human interpreters | On-demand interpreting | Expensive, not available for routine calls |

**VaakSetu's moat:**
- Sarvam AI models outperform Google Translate for Indian languages — quality edge
- First-mover in voice bridge for Indian language pairs in BFSI
- Conversation data accumulation over time improves quality
- Deep Indic language coverage (11 languages) vs international players

**Real threat:**
- Sarvam AI themselves building this product
- Jio or Airtel bundling it into business voice stack
- Defensibility window: move fast into one vertical, get sticky integrations (bank CRM/dialer), accumulate data

---

## 9. Founder Situation — Honest Constraints

**Current reality:**
- Solo builder, using Claude as co-builder
- Working corporate job, not willing to leave yet
- Part-time: realistically 15–20 hours/week (good week), 6–8 hours/week (bad week)
- No team, no company registered, no external funding

**Implications:**
- 200–300 hours of engineering needed for full PSTN bridge = 3–5 months at current pace
- Cannot do sales + marketing + legal + engineering simultaneously
- Revenue is 0 until first paying customer

### Recommended 3-Month Roadmap

**Month 1 — Minimum Viable Bridge**
- Exotel integration: two call legs connected, live translation working end-to-end
- No dashboard, no security layer, no polish
- Test yourself + 2–3 contacts who have the language problem
- Goal: prove the call experience works

**Month 2 — First Real Users**
- Find 3–5 people through network who have this problem professionally (not investors, not banks — actual users)
- Give them the number for free
- Talk to them weekly: what breaks, what delights, how often do they use it
- Goal: real usage data on call frequency and session length

**Month 3 — Decision Point**
- If people are actually using it → push harder part-time or make a plan toward going full-time
- If not → learn cheaply and pivot without having wasted a year
- Goal: enough signal to make a better decision about next 6 months

---

## 10. Pre-Implementation Checklist (Do Before Writing Code)

- [ ] **Read your employment contract** — check IP assignment and non-compete clauses. This is blocking. Do it before any further development.
- [ ] **Verify Sarvam AI data residency** — email/call them and get written confirmation that audio processing stays within India.
- [ ] **Find 3–5 people with the problem** — specifically people who personally experience Hindi↔Tamil/Telugu communication friction at work. They are your compass.
- [ ] **Set up a simple DPA template** — can use a standard Indian DPA template from a legal doc service like LegalDesk or Lawrato. ~₹2,000–5,000.
- [ ] **Register OPC or sole proprietorship** — only when someone wants to pay you. Not before.
- [ ] **Pick telephony provider** — evaluate Exotel vs Telnyx for streaming API quality and India PSTN coverage. Create a free developer account and test the streaming API.

---

## 11. Key Technical Decisions Already Made

These are settled — don't revisit without strong reason:

| Decision | What was chosen | Why |
|---|---|---|
| STT for Indian languages | Sarvam Saaras v3 | Outperforms Google for Indic languages |
| Translation for Indian languages | Sarvam Mayura v1 | Better Indic fluency, formal mode |
| TTS for Indian languages | Sarvam Bulbul v3 | Native Indic voice quality |
| STT for international | Groq Whisper large-v3 | ~20-40x cheaper than OpenAI, comparable quality |
| Translation for international | Groq Llama 70B | 8B hallucinates; 70B reliable; wrap in `<translate>` XML tags |
| TTS for international | ElevenLabs Turbo v2.5 | Quality; OpenAI TTS-1 kept as fallback |
| Hosting | Vercel Mumbai (bom1) | Closest region to Sarvam API = lowest latency |
| WebRTC | PeerJS | Already integrated; STUN with Google servers |
| Auth | Supabase | Already integrated |
| Translation routing | English as pivot language | Sarvam Mayura only supports en ↔ Indian pairs |
| Mayura mode | `formal` | `modern-colloquial` breaks for non-Hinglish speakers |

---

## 12. Known Technical Gotchas (Don't Repeat These)

- **Odia language code:** STT uses `or-IN`, Mayura + Bulbul use `od-IN`. Normalize via `toSTTCode()` / `toNonSTTCode()` helpers.
- **Groq Whisper:** Must use `whisper-large-v3`, NOT `whisper-large-v3-turbo` — turbo has no `/translations` endpoint. Language param must be ISO-639-1 (`hi` not `hi-IN`).
- **Groq Llama prompting:** Wrap user text in `<translate>...</translate>` XML tags so model doesn't interpret phrases like "give me tips" as instructions.
- **Bulbul TTS limit:** Rejects >500 chars. Use `chunkText()` to split at sentence → comma → whitespace boundaries. Returns `string[]`.
- **Mayura translate limit:** Rejects >1000 chars. Chunk at `MAX_TRANSLATE_CHARS = 900`.
- **iOS Safari:** `getUserMedia` must be called synchronously in user gesture. Never call from `setTimeout`. Reuse MediaStream in Go Live mode.
- **iOS audio:** Strip `;codecs=...` suffix from MIME before creating Blob. Use `audio/mp4` preferred, fallback `audio/webm`.
- **OpenAI TTS:** Returns binary mp3 ArrayBuffer → convert to base64 via `arrayBufferToBase64()` → reuse `playBase64Audio`.
- **WebRTC cross-device:** Both devices must use same URL. Laptop on `localhost` + phone on production = different signaling contexts = connection fails.
- **Streaming WebSocket key:** API key is in the WSS URL query param — visible in devtools. Accepted tradeoff. Use `VITE_SARVAM_API_KEY` as public Vercel env var.
- **Env var routing:** Use `envOr()` helper — prefer `.env` value, fall back to localStorage only when env var is truly absent (not empty string). Prevents stale OpenAI keys overriding intentional empty `VITE_OPENAI_API_KEY=`.
- **Chrome extension mic permission:** Offscreen documents cannot request mic permission on their own. Trigger `getUserMedia({audio:true})` from popup (has user gesture). Offscreen inherits the grant.

---

## 13. Vercel Environment Variables Required

```bash
# Sarvam (Indian language pipeline)
SARVAM_API_KEY=          # serverless proxy functions
VITE_SARVAM_API_KEY=     # WebSocket streaming (public, baked into bundle)

# Groq (preferred international pipeline)
GROQ_API_KEY=
VITE_GROQ_API_KEY=       # client routing decision

# ElevenLabs (international TTS)
ELEVENLABS_API_KEY=
VITE_ELEVENLABS_API_KEY=

# OpenAI (fallback — optional)
OPENAI_API_KEY=
VITE_OPENAI_API_KEY=     # leave empty to keep OpenAI out of routing

# Supabase
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Extension (when ready)
VITE_EXTENSION_ID=       # chrome://extensions ID
```

---

## 14. Useful Reference Links

- **Live app:** https://vaak-setu.vercel.app
- **Sarvam AI docs:** https://docs.sarvam.ai
- **Sarvam dashboard (API keys):** https://dashboard.sarvam.ai
- **Exotel streaming API:** https://exotel.com/developers
- **Telnyx media streaming:** https://developers.telnyx.com
- **PeerJS docs:** https://peerjs.com/docs
- **Supabase docs:** https://supabase.com/docs
- **Vercel serverless functions:** https://vercel.com/docs/functions
- **OPC registration India:** https://www.mca.gov.in

---

*Last updated: 29 May 2026. Update this document as implementation progresses.*
