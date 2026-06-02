// config.js — env + constants for the relay server.
// All secrets come from the host's env vars (Render dashboard for POC).
// Mirror the same keys the Vercel functions already use.

export const PORT = Number(process.env.PORT) || 8080;

// Upstream AI provider keys (same vars as the Vercel /api/* functions).
export const SARVAM_API_KEY    = process.env.SARVAM_API_KEY    || '';
export const GROQ_API_KEY      = process.env.GROQ_API_KEY      || '';
export const GOOGLE_TTS_API_KEY = process.env.GOOGLE_TTS_API_KEY || '';

// LiveKit — the relay joins the customer's room as a server-side participant,
// subscribes to the customer's mic, and publishes the agent's translated speech
// back into the room. Free Cloud tier (or self-host) replaces Recall.ai.
export const LIVEKIT_URL        = process.env.LIVEKIT_URL || '';        // wss://<project>.livekit.cloud
export const LIVEKIT_API_KEY    = process.env.LIVEKIT_API_KEY || '';
export const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || '';

// Sample rate the relay uses for its outbound (injected) audio track. LiveKit
// resamples internally as needed; 24 kHz is a good quality/cost balance.
export const INJECT_SAMPLE_RATE = 24000;

// Supabase service-role — for writing bot_sessions + usage_events. Optional:
// if absent, logging is skipped (relay still works for dev/POC).
export const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// Audio constants — Sarvam STT wants 16 kHz mono 16-bit PCM.
export const SAMPLE_RATE = 16000;

// VAD tuning (ported from the extension's createVadLoop; already field-tuned).
export const VAD = {
  SILENCE_THRESHOLD: 6,    // RMS on a gain-boosted signal
  SILENCE_MS:        700,  // sustained quiet → end of utterance
  MIN_SPEECH_MS:     400,  // must hear this much speech before arming
  GAP_TOLERANCE_MS:  250,  // inter-word pauses below this don't reset the accumulator
};

// Indian-language codes (Sarvam). Everything else routes through Groq/Google.
export const INDIAN_CODES = new Set([
  'hi-IN', 'en-IN', 'bn-IN', 'gu-IN', 'kn-IN', 'ml-IN',
  'mr-IN', 'or-IN', 'pa-IN', 'ta-IN', 'te-IN',
]);
export const isIndianLang = (code) => INDIAN_CODES.has(code);

// Bulbul voices.
export const SARVAM_VOICES = { male: 'anand', female: 'ritu' };
