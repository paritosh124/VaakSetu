// authedFetch(url, options) — drop-in for fetch() that attaches the
// Supabase access token as Authorization: Bearer <jwt> when auth is active.
// When Supabase isn't configured it behaves exactly like plain fetch.
import { supabase, authEnabled } from './supabase';

export async function authedFetch(url, options = {}) {
  if (!authEnabled) return fetch(url, options);
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) return fetch(url, options); // will likely 401 — let the caller surface the error
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, { ...options, headers });
}
