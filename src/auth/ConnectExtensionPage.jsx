// /connect-extension — handoff page that hands the user's Supabase session
// to the VaakSetu Chrome extension via chrome.runtime.sendMessage. The
// extension declares vaak-setu.vercel.app in its `externally_connectable`
// manifest list so this exact origin is the only place that can deliver a
// session.
//
// Flow:
//   1. User opens https://vaak-setu.vercel.app/connect-extension from the
//      extension popup ("Sign in to VaakSetu" button).
//   2. If not signed in, they see the regular login page first.
//   3. Once signed in, click "Connect Extension" → we post the session +
//      Supabase URL/anon key into the extension. Extension stores it,
//      future API calls carry the JWT.
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';
import { LoginPage } from './LoginPage';

// Extension ID — needed so chrome.runtime.sendMessage knows which extension
// to deliver to. Pulled from a Vite env var (set per build) so the
// Production / staging builds can target their respective extension IDs.
//
// To find your extension's ID: chrome://extensions → toggle Developer Mode →
// the ID is the hex string under VaakSetu. Paste it into Vercel as
// VITE_EXTENSION_ID, then redeploy.
const EXTENSION_ID = import.meta.env.VITE_EXTENSION_ID || '';

export function ConnectExtensionPage() {
  const { user, profile, loading } = useAuth();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return <Center text="Loading…" />;
  if (!user) return <LoginPage />;

  const connect = async () => {
    setBusy(true);
    setStatus('');
    if (!EXTENSION_ID) {
      setStatus('Extension ID not configured. Ask the admin to set VITE_EXTENSION_ID on Vercel.');
      setBusy(false);
      return;
    }
    if (typeof chrome === 'undefined' || !chrome?.runtime?.sendMessage) {
      setStatus('Chrome extension API not available. Open this page in Google Chrome with the VaakSetu extension installed.');
      setBusy(false);
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      setStatus('Session expired. Please refresh the page.');
      setBusy(false);
      return;
    }
    // Bundle the Supabase URL + anon key with the session so the extension
    // can refresh tokens later without needing build-time env injection.
    const payload = {
      ...session,
      _supabase_url:      import.meta.env.VITE_SUPABASE_URL || '',
      _supabase_anon_key: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
      profile: { org_id: profile?.org_id, role: profile?.role },
    };
    chrome.runtime.sendMessage(EXTENSION_ID, { type: 'auth-set-session', session: payload }, (response) => {
      setBusy(false);
      const lastErr = chrome.runtime.lastError;
      if (lastErr) {
        setStatus(`Could not reach the extension: ${lastErr.message}. Make sure VaakSetu is installed and reload the extension once.`);
        return;
      }
      if (response?.ok) {
        setStatus('✓ Extension connected. You can close this tab and use VaakSetu.');
      } else {
        setStatus(`Extension responded but didn't accept the session: ${response?.error || 'unknown error'}`);
      }
    });
  };

  return (
    <div style={s.root}>
      <div style={s.card}>
        <h1 style={s.title}>VaakSetu</h1>
        <p style={s.subtitle}>Connect Chrome Extension</p>

        <div style={s.signedAs}>
          Signed in as <b>{user.email}</b>
          {profile?.role === 'admin' && <span style={s.adminPill}>admin</span>}
        </div>

        <button style={s.primaryBtn} onClick={connect} disabled={busy}>
          {busy ? 'Connecting…' : 'Connect Extension'}
        </button>

        {status && <p style={status.startsWith('✓') ? s.okMsg : s.errMsg}>{status}</p>}

        <p style={s.hint}>
          Pinning the extension first? Open <b>chrome://extensions</b>, enable <b>VaakSetu</b>,
          pin its icon to the toolbar, then come back here and click Connect.
        </p>
      </div>
    </div>
  );
}

function Center({ text }) {
  return (
    <div style={{ ...s.root, color: '#8E8AA0', fontSize: 13 }}>{text}</div>
  );
}

const s = {
  root: {
    minHeight: '100vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0C0B1A',
    color: '#EDE9F5',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    padding: 16,
  },
  card: {
    width: '100%', maxWidth: 420,
    background: '#151329', borderRadius: 16, padding: 28,
    boxShadow: '0 20px 60px rgba(0,0,0,.35)',
  },
  title:    { fontSize: 28, fontWeight: 700, margin: 0, color: '#F5A623' },
  subtitle: { fontSize: 14, color: '#8E8AA0', margin: '4px 0 18px' },
  signedAs: {
    background: '#1f1c3d', border: '1px solid #2a2750', borderRadius: 8,
    padding: '10px 12px', marginBottom: 14, fontSize: 13, color: '#EDE9F5',
  },
  adminPill: {
    marginLeft: 10, padding: '1px 7px', borderRadius: 999,
    background: '#F5A623', color: '#0C0B1A', fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
  },
  primaryBtn: {
    width: '100%', padding: '11px 14px', borderRadius: 8, border: 'none',
    background: '#F5A623', color: '#0C0B1A', fontWeight: 600, fontSize: 14, cursor: 'pointer',
  },
  okMsg:  { marginTop: 14, fontSize: 13, color: '#0FB8A9' },
  errMsg: { marginTop: 14, fontSize: 13, color: '#E5484D' },
  hint:   { marginTop: 18, fontSize: 11, color: '#8E8AA0', lineHeight: 1.5 },
};
