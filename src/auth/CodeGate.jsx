import { useState } from 'react';

const STORAGE_KEY = 'vs_access_code';
const EXPECTED    = import.meta.env.VITE_APP_ACCESS_CODE || '';

export function CodeGate({ children }) {
  const [input,  setInput]  = useState('');
  const [error,  setError]  = useState(false);
  const [shake,  setShake]  = useState(false);

  // No code configured → gate is disabled
  if (!EXPECTED) return children;

  // Already granted in this browser
  if (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === EXPECTED) {
    return children;
  }

  function attempt() {
    if (input.trim() === EXPECTED) {
      localStorage.setItem(STORAGE_KEY, EXPECTED);
      // Force re-render by reloading — simplest way to pass children through
      window.location.reload();
    } else {
      setError(true);
      setShake(true);
      setTimeout(() => setShake(false), 500);
    }
  }

  function onKey(e) {
    if (error) setError(false);
    if (e.key === 'Enter') attempt();
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0C0B1A', fontFamily: '"DM Sans", system-ui, sans-serif', padding: 24,
    }}>
      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0); }
          20%      { transform: translateX(-8px); }
          40%      { transform: translateX(8px); }
          60%      { transform: translateX(-6px); }
          80%      { transform: translateX(6px); }
        }
        .vs-cg-card { animation: none; }
        .vs-cg-card.shake { animation: shake 0.45s ease; }
        .vs-cg-input {
          width: 100%; padding: 13px 16px; font-size: 16px; border-radius: 8px;
          background: #0C0B1A; color: #EDE9F5; font-family: inherit;
          border: 1.5px solid rgba(255,255,255,0.18); outline: none;
          transition: border-color 0.15s; letter-spacing: 0.08em;
        }
        .vs-cg-input:focus { border-color: #F5A623; }
        .vs-cg-input.err   { border-color: #E05555; }
        .vs-cg-btn {
          width: 100%; padding: 14px; font-size: 16px; font-weight: 600;
          background: #F5A623; color: #0C0B1A; border: none; border-radius: 8px;
          cursor: pointer; font-family: inherit; transition: opacity 0.15s;
        }
        .vs-cg-btn:hover { opacity: 0.88; }
      `}</style>

      <div className={`vs-cg-card${shake ? ' shake' : ''}`} style={{
        background: '#161429', border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 380,
        textAlign: 'center',
      }}>
        <div style={{ fontFamily: '"Crimson Pro", serif', fontSize: 26, fontWeight: 700, color: '#F5A623', marginBottom: 6 }}>
          VaakSetu
        </div>
        <p style={{ color: '#9B97B0', fontSize: 14, marginBottom: 32 }}>
          Enter your access code to continue
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            className={`vs-cg-input${error ? ' err' : ''}`}
            type="password"
            placeholder="Access code"
            value={input}
            onChange={e => { setInput(e.target.value); setError(false); }}
            onKeyDown={onKey}
            autoFocus
          />
          {error && (
            <p style={{ color: '#E05555', fontSize: 13, textAlign: 'left', margin: '-4px 0 0' }}>
              Incorrect code. Try again.
            </p>
          )}
          <button className="vs-cg-btn" onClick={attempt}>
            Continue →
          </button>
        </div>

        <p style={{ color: '#9B97B0', fontSize: 12, marginTop: 24 }}>
          Don't have a code?{' '}
          <a href="/" style={{ color: '#F5A623', textDecoration: 'none' }}>Request access</a>
        </p>
      </div>
    </div>
  );
}
