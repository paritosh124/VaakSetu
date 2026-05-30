// Shared auth + usage-logging helpers for /api/* serverless functions.
//
// Design:
//   • If SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are set → auth is ON.
//     Every request must carry a valid Bearer JWT (issued to a signed-in
//     user by Supabase). On success a usage_events row is written.
//   • If those env vars are missing → auth is OFF. Requests pass through
//     unchanged. Useful for local dev before Supabase is wired, or for
//     one-off diagnostics. Production MUST set both.
//
// The wrapper is composed with handlePreflight (CORS) and a HEAD short-
// circuit so every endpoint gets consistent behaviour for free.
import { createClient } from '@supabase/supabase-js';
import { handlePreflight } from './_cors.js';

const SUPABASE_URL       = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_ROLE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const authEnabled = Boolean(SUPABASE_URL && SERVICE_ROLE_KEY) && process.env.AUTH_ENABLED !== 'false';

// Service-role client bypasses RLS — safe here because we're running on the
// server behind Vercel's env-var secrecy, and we only use it to (a) validate
// tokens and (b) insert usage rows on behalf of the authenticated user.
const adminClient = authEnabled
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

// Returns { user, profile } for a valid JWT, or null for bad/missing token.
async function validateAuth(req) {
  if (!authEnabled) return { user: null, profile: null };
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const { data, error } = await adminClient.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: profile } = await adminClient
    .from('profiles')
    .select('id, org_id, role, email')
    .eq('id', data.user.id)
    .single();
  if (!profile) return null; // auth user without a profile = invited-trigger failure
  return { user: data.user, profile };
}

// Fire-and-forget usage insert. Never blocks or throws — a logging failure
// must not break the primary response.
export function logUsage(auth, event) {
  if (!authEnabled || !auth?.user || !auth?.profile) return;
  adminClient
    .from('usage_events')
    .insert({
      user_id: auth.user.id,
      org_id:  auth.profile.org_id,
      event_type:     event.event_type,
      provider:       event.provider || null,
      source_lang:    event.source_lang || null,
      target_lang:    event.target_lang || null,
      chars:          event.chars ?? null,
      duration_ms:    event.duration_ms ?? null,
      api_cost_cents: event.api_cost_cents ?? null,
      metadata:       event.metadata || null,
    })
    .then(({ error }) => {
      if (error) console.warn('[usage] insert failed:', error.message);
    });
}

// Very rough cost estimator (in cents). These are order-of-magnitude numbers
// for monthly-spend visibility, not billing-accurate. Tune once you have
// real invoices from each provider.
const COST_TABLE = {
  // Sarvam: ~₹0.50 per short call, scale with char count.
  sarvam_stt:       ({ duration_ms = 0 })  => Math.max(1, Math.round(duration_ms / 1000 * 0.6)),
  sarvam_translate: ({ chars = 0 })        => Math.max(1, Math.round(chars / 100 * 0.4)),
  sarvam_tts:       ({ chars = 0 })        => Math.max(1, Math.round(chars / 100 * 0.6)),
  // Groq Whisper: free-ish; small cost per minute.
  groq_stt:         ({ duration_ms = 0 })  => Math.max(1, Math.round(duration_ms / 60000 * 1)),
  groq_chat:        ({ chars = 0 })        => Math.max(1, Math.round(chars / 500 * 0.3)),
  // ElevenLabs Turbo: ~$0.18/1000 chars ≈ 2¢ per 100 chars.
  elevenlabs_tts:   ({ chars = 0 })        => Math.max(1, Math.round(chars / 100 * 2)),
  // OpenAI TTS-1: $15/1M chars ≈ 1.5¢ per 1000 chars.
  openai_stt:       ({ duration_ms = 0 })  => Math.max(1, Math.round(duration_ms / 60000 * 60)),
  openai_chat:      ({ chars = 0 })        => Math.max(1, Math.round(chars / 1000 * 2)),
  openai_tts:       ({ chars = 0 })        => Math.max(1, Math.round(chars / 1000 * 15)),
};
export function estimateCost(key, meta) {
  return (COST_TABLE[key] || (() => 0))(meta || {});
}

// Handler wrapper:
//   export default withAuth(async (req, res) => { … req.auth.user, req.auth.profile … });
export function withAuth(handler) {
  return async (req, res) => {
    if (handlePreflight(req, res)) return;
    if (req.method === 'HEAD') { res.status(204).end(); return; }

    const auth = await validateAuth(req);
    if (authEnabled && !auth) {
      res.status(401).json({ error: 'Unauthorized — sign in to VaakSetu first.' });
      return;
    }
    req.auth = auth; // available inside the handler
    return handler(req, res);
  };
}
