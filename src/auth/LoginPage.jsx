// Login page — OAuth buttons + magic-link fallback.
// Invite-only: any OAuth email without a matching invitations row will be
// blocked by the DB trigger on_auth_user_created.
import { useState } from 'react';
import { supabase } from '../lib/supabase';

const providers = [
  { id: 'google',   label: 'Continue with Google'    },
  { id: 'azure',    label: 'Continue with Microsoft' },
  { id: 'github',   label: 'Continue with GitHub'    },
];

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const oauth = async (provider) => {
    setBusy(true); setStatus('');
    const { error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
    if (error) { setStatus(error.message); setBusy(false); }
  };

  const magicLink = async (e) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true); setStatus('');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) setStatus(error.message);
    else setStatus('Check your inbox for the login link. (In local dev: http://localhost:54324)');
    setBusy(false);
  };

  return (
    <div style={s.root}>
      <div style={s.card}>
        <h1 style={s.title}>VaakSetu</h1>
        <p style={s.subtitle}>Sign in to continue</p>

        <div style={s.btnCol}>
          {providers.map((p) => (
            <button
              key={p.id}
              style={s.oauthBtn}
              onClick={() => oauth(p.id)}
              disabled={busy}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div style={s.divider}><span style={s.dividerText}>or</span></div>

        <form onSubmit={magicLink} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            style={s.input}
            type="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            required
          />
          <button style={s.primaryBtn} type="submit" disabled={busy || !email}>
            Email me a login link
          </button>
        </form>

        {status && <p style={s.status}>{status}</p>}

        <p style={s.hint}>
          Access is invite-only. Ask your admin to invite your work email.
        </p>
      </div>
    </div>
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
    width: '100%',
    maxWidth: 380,
    background: '#151329',
    borderRadius: 16,
    padding: 28,
    boxShadow: '0 20px 60px rgba(0,0,0,.35)',
  },
  title:    { fontSize: 28, fontWeight: 700, margin: 0, color: '#F5A623' },
  subtitle: { fontSize: 14, color: '#8E8AA0', margin: '4px 0 20px' },
  btnCol:   { display: 'flex', flexDirection: 'column', gap: 8 },
  oauthBtn: {
    padding: '11px 14px',
    borderRadius: 8,
    border: '1px solid #2a2750',
    background: '#1f1c3d',
    color: '#EDE9F5',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  divider: {
    textAlign: 'center',
    margin: '18px 0',
    borderTop: '1px solid #2a2750',
    position: 'relative',
    height: 0,
  },
  dividerText: {
    position: 'relative',
    top: -10,
    background: '#151329',
    padding: '0 10px',
    color: '#8E8AA0',
    fontSize: 12,
  },
  input: {
    padding: '11px 12px',
    borderRadius: 8,
    border: '1px solid #2a2750',
    background: '#1f1c3d',
    color: '#EDE9F5',
    fontSize: 14,
    outline: 'none',
  },
  primaryBtn: {
    padding: '11px 14px',
    borderRadius: 8,
    border: 'none',
    background: '#F5A623',
    color: '#0C0B1A',
    fontWeight: 600,
    fontSize: 14,
    cursor: 'pointer',
  },
  status: { marginTop: 14, fontSize: 12, color: '#0FB8A9' },
  hint:   { marginTop: 18, fontSize: 11, color: '#8E8AA0', lineHeight: 1.5 },
};
