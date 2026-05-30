// Extension auth module.
//
// We don't run @supabase/supabase-js in the extension because (a) the service
// worker auto-refresh interval is unreliable across worker sleeps, and (b) we
// only need three operations: hold session, refresh on expiry, surface an
// access token. So this is a minimal hand-rolled helper backed by
// chrome.storage.local.
//
// Session shape (matches what supabase.auth.getSession() returns):
//   {
//     access_token, refresh_token,
//     expires_at,   // unix seconds (sometimes called expires_at, sometimes derived)
//     token_type, expires_in,
//     user: { id, email, ... }
//   }
//
// Plus we attach a `profile` blob ({ org_id, role }) the first time we see
// the session, so widget/popup can show the user's email/role without
// hitting the DB on every popup open.

import { AUTH_ENABLED } from './config.js';

const STORAGE_KEY = 'vaaksetu_session';

// Some extension contexts (notably offscreen documents in some Chrome
// builds) don't have direct chrome.storage access, even though the service
// worker and popup do. We try direct first; if it's missing or throws, we
// fall back to asking the service worker via chrome.runtime.sendMessage.
function hasDirectStorage() {
  try { return !!(chrome && chrome.storage && chrome.storage.local); }
  catch { return false; }
}

async function loadSession() {
  if (hasDirectStorage()) {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] || null;
    } catch (err) {
      console.warn('[vaaksetu auth] direct loadSession failed, falling back to SW:', err.message);
    }
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'auth-internal-get' });
    return resp?.session || null;
  } catch (err) {
    console.warn('[vaaksetu auth] SW loadSession failed:', err.message);
    return null;
  }
}

async function saveSession(session) {
  if (hasDirectStorage()) {
    try { await chrome.storage.local.set({ [STORAGE_KEY]: session }); return; }
    catch (err) { console.warn('[vaaksetu auth] direct saveSession failed, falling back:', err.message); }
  }
  try { await chrome.runtime.sendMessage({ type: 'auth-internal-set', session }); }
  catch (err) { console.warn('[vaaksetu auth] SW saveSession failed:', err.message); }
}

async function clearSession() {
  if (hasDirectStorage()) {
    try { await chrome.storage.local.remove(STORAGE_KEY); return; }
    catch {}
  }
  try { await chrome.runtime.sendMessage({ type: 'auth-internal-clear' }); }
  catch {}
}

// Discovers the Supabase URL the extension should refresh tokens against.
// We need this URL inside the service worker, but the extension has no Vite
// env. So when the webapp hands us the session it must include the supabase
// project URL too — we tuck it into session._supabase_url.
function supabaseUrlFromSession(session) {
  return session?._supabase_url || null;
}

// Refresh the access token via Supabase's REST endpoint. Returns the new
// session (with .access_token rotated) or null on failure.
async function refreshAccessToken(session) {
  const url = supabaseUrlFromSession(session);
  const refresh_token = session?.refresh_token;
  if (!url || !refresh_token) return null;
  try {
    const res = await fetch(`${url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: session._supabase_anon_key || '' },
      body: JSON.stringify({ refresh_token }),
    });
    if (!res.ok) {
      console.warn('[vaaksetu auth] refresh failed', res.status, await res.text().catch(() => ''));
      return null;
    }
    const data = await res.json();
    const next = {
      ...session,
      access_token: data.access_token,
      refresh_token: data.refresh_token || refresh_token,
      expires_at: data.expires_at || (Math.floor(Date.now() / 1000) + (data.expires_in || 3600)),
      expires_in: data.expires_in,
      user: data.user || session.user,
    };
    await saveSession(next);
    return next;
  } catch (err) {
    console.warn('[vaaksetu auth] refresh error', err?.message);
    return null;
  }
}

// Returns a valid access token (refreshing if within 60s of expiry).
// null = not signed in or refresh failed; caller should prompt re-auth.
export async function getAccessToken() {
  let session = await loadSession();
  if (!session) {
    console.warn('[vaaksetu auth] no session in chrome.storage.local');
    return null;
  }
  if (!session.access_token) {
    console.warn('[vaaksetu auth] session present but access_token missing — keys:', Object.keys(session));
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  const exp = session.expires_at || 0;
  if (exp && exp - now < 60) {
    console.log(`[vaaksetu auth] token expiring in ${exp - now}s, refreshing`);
    const refreshed = await refreshAccessToken(session);
    if (!refreshed) {
      console.warn('[vaaksetu auth] refresh failed — clearing session');
      await clearSession();
      return null;
    }
    session = refreshed;
  }
  return session.access_token;
}

// Returns the current session metadata for UI (email, role, org).
export async function getProfileInfo() {
  const session = await loadSession();
  if (!session?.user) return null;
  return {
    email: session.user.email,
    user_id: session.user.id,
    role:   session.profile?.role  || 'agent',
    org_id: session.profile?.org_id,
  };
}

// Called by background.js when the webapp's connect page hands us a session.
export async function setSession(session) {
  if (!session?.access_token || !session?.user) {
    throw new Error('Invalid session payload from webapp.');
  }
  await saveSession(session);
}

export async function signOut() {
  await clearSession();
}

// Plain fetch wrapper that attaches Authorization automatically.
// When AUTH_ENABLED is false, falls through to plain fetch so the extension
// works without a Supabase session.
export async function authedFetch(url, options = {}) {
  if (!AUTH_ENABLED) return fetch(url, options);
  const token = await getAccessToken();
  if (!token) throw new Error('NOT_SIGNED_IN');
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, { ...options, headers });
}
