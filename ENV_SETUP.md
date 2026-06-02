# Deployment Environment Variables

Two deploy targets:
- **Vercel** — frontend + `/api` serverless functions
- **Render** — the relay server (`src/server/`) for live calls / Meeting Bot

> `.env.example` (in this repo) is for **local dev** only. This file is the
> **production** reference for the Vercel + Render dashboards.

---

## VERCEL — required (exactly 12, fits your limit)

| # | Variable | What to put | Used by |
|---|---|---|---|
| 1 | `SARVAM_API_KEY` | Sarvam key | `/api` proxies (Indian STT/translate/TTS) |
| 2 | `GROQ_API_KEY` | Groq key | `/api` proxies (intl STT + translate) |
| 3 | `GOOGLE_TTS_API_KEY` | Google Cloud TTS key | `/api` proxy (intl voices) |
| 4 | `VITE_SUPABASE_URL` | `https://<proj>.supabase.co` | client auth **and** server `_auth.js` |
| 5 | `VITE_SUPABASE_ANON_KEY` | Supabase anon (public) key | client auth |
| 6 | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key | server: validate JWT, write usage |
| 7 | `VITE_SARVAM_API_KEY` | same Sarvam key as #1 | webapp streaming STT (WebSocket) |
| 8 | `LIVEKIT_URL` | `wss://<proj>.livekit.cloud` | `/api/bot/create` |
| 9 | `LIVEKIT_API_KEY` | LiveKit key | `/api/bot/create` (mint customer token) |
| 10 | `LIVEKIT_API_SECRET` | LiveKit secret | `/api/bot/create` |
| 11 | `VITE_BOT_RELAY_HTTP_URL` | `https://<app>.onrender.com` | client wakes relay + server registers session (WS url derived as `wss://…`) |
| 12 | `RELAY_SHARED_SECRET` | random string — `openssl rand -hex 16` | guards relay `/sessions`; **must match Render** |

### Optional (only if you need them — each costs a slot)
- `VITE_GROQ_API_KEY` — only for **international** languages in the standalone `/app` translator. The Meeting Bot routes intl server-side, so it does **not** need this.
- `VITE_APP_ACCESS_CODE` — only if you keep the invite/code gate on `/app`.
- `WEBAPP_URL` — only if your domain isn't `https://vaak-setu.vercel.app` (that's the default baked in code).

### Delete these (you don't use them — frees 5 slots)
`OPENAI_API_KEY`, `VITE_OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `VITE_ELEVENLABS_API_KEY`, `VITE_EXTENSION_ID`
```bash
vercel env rm OPENAI_API_KEY production
vercel env rm VITE_OPENAI_API_KEY production
vercel env rm ELEVENLABS_API_KEY production
vercel env rm VITE_ELEVENLABS_API_KEY production
vercel env rm VITE_EXTENSION_ID production
vercel --prod        # redeploy so the new build picks up the changes
```

---

## RENDER — the relay (`src/server/`)

The relay is a **separate host**, so it needs its own copy of the AI + LiveKit
keys (same values as Vercel). The relay runs the translation pipeline directly —
it does **not** go through Vercel.

### Required (7)
| Variable | What to put |
|---|---|
| `LIVEKIT_URL` | same as Vercel |
| `LIVEKIT_API_KEY` | same as Vercel |
| `LIVEKIT_API_SECRET` | same as Vercel |
| `SARVAM_API_KEY` | same as Vercel |
| `GROQ_API_KEY` | same as Vercel |
| `GOOGLE_TTS_API_KEY` | same as Vercel |
| `RELAY_SHARED_SECRET` | **same value** as Vercel's `RELAY_SHARED_SECRET` |

### Optional (2 — only for transcript logging to `bot_sessions`)
| Variable | What to put |
|---|---|
| `SUPABASE_URL` | `https://<proj>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key |

### Do NOT set
- `PORT` — Render injects it automatically (code defaults to 8080 locally).

---

## Deploy order (avoids a chicken-and-egg)

1. Deploy the relay to **Render first** (root dir `src/server`, build `npm install`, start `npm start`) → note its URL.
2. Set the Render vars above.
3. Put that URL into Vercel's `VITE_BOT_RELAY_HTTP_URL`, set the rest of the Vercel vars.
4. **Redeploy Vercel** (`vercel --prod`) — the `VITE_*` vars are baked at build time, so they only take effect on a fresh build.

## Where to get the keys
- **LiveKit**: livekit.io → sign up (personal email is fine) → create a project → Settings/Keys gives `LIVEKIT_URL`, key, secret.
- **Sarvam / Groq / Google TTS / Supabase**: you already have these on Vercel — reuse the same values on Render.
