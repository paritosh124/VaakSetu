// Supabase client singleton.
// If env vars aren't set we export null and the AuthProvider treats auth as
// disabled (dev mode without login). That keeps the app runnable even if
// you haven't spun up Supabase yet.
import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && anonKey
  ? createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const authEnabled = Boolean(supabase) && import.meta.env.VITE_AUTH_ENABLED !== 'false';
