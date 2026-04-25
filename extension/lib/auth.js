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

const STORAGE_KEY = 'vaaksetu_session';

// Defensive guard: if chrome.storage isn't available (e.g. module is being
// loaded outside an extension context, or during a service-worker boot that
// hasn't finished setup), fail clean with a clear message instead of
// "cannot read properties of undefined".
function storage() {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
    throw new Error('chrome.storage.local unavailable in this context');
  }
  return chrome.storage.local;
}

async function loadSession() {
  try {
    const result = await storage().get(STORAGE_KEY);
    return result[STORAGE_KEY] || null;
  } catch (err) {
    console.warn('[vaaksetu auth] loadSession failed:', err.message);
    return null;
  }
}

async function saveSession(session) {
  await storage().set({ [STORAGE_KEY]: session });
}

async function clearSession() {
  try { await storage().remove(STORAGE_KEY); } catch {}
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
  if (!session?.access_token) return null;
  const now = Math.floor(Date.now() / 1000);
  const exp = session.expires_at || 0;
  if (exp - now < 60) {
    const refreshed = await refreshAccessToken(session);
    if (!refreshed) return null;
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

// Plain fetch wrapper that attaches Authorization automatically. Throws if
// the user isn't signed in — callers should handle and surface a helpful
// message ("Sign in to VaakSetu first").
export async function authedFetch(url, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('NOT_SIGNED_IN');
  const headers = { ...(options.headers || {}), Authorization: `Bearer ${token}` };
  return fetch(url, { ...options, headers });
}
