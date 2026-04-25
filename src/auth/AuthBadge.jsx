// Tiny floating overlay showing the signed-in user + sign-out link.
// Admins also get an "Admin" button that opens the usage dashboard as a full-
// screen overlay (so it doesn't require a router to be wired into the app).
import { useState } from 'react';
import { useAuth } from './AuthProvider.jsx';
import { AdminPage } from './AdminPage.jsx';

export function AuthBadge() {
  const { profile, authEnabled, signOut } = useAuth();
  const [showAdmin, setShowAdmin] = useState(false);
  if (!authEnabled || !profile) return null;
  return (
    <>
      <div style={s.wrap}>
        <span style={s.email}>{profile.email}</span>
        {profile.role === 'admin' && (
          <>
            <span style={s.role}>admin</span>
            <button style={s.btn} onClick={() => setShowAdmin(true)}>Admin</button>
          </>
        )}
        <button style={s.btn} onClick={signOut}>Sign out</button>
      </div>
      {showAdmin && <AdminPage onClose={() => setShowAdmin(false)} />}
    </>
  );
}

const s = {
  wrap: {
    position: 'fixed',
    top: 10,
    right: 10,
    zIndex: 10000,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '6px 10px',
    background: 'rgba(21, 19, 41, 0.9)',
    border: '1px solid #2a2750',
    borderRadius: 20,
    fontFamily: 'system-ui, -apple-system, sans-serif',
    fontSize: 11,
    color: '#EDE9F5',
    backdropFilter: 'blur(6px)',
  },
  email: { color: '#EDE9F5', opacity: 0.9 },
  role:  { color: '#F5A623', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' },
  btn: {
    padding: '3px 8px',
    background: 'transparent',
    border: '1px solid #2a2750',
    borderRadius: 12,
    color: '#8E8AA0',
    fontSize: 10,
    cursor: 'pointer',
  },
};
