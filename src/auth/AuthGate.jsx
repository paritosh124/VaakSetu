// Decides what to render based on auth state:
//   • authEnabled === false              → pass through (local dev w/o Supabase)
//   • loading                            → spinner
//   • logged in + profile loaded         → children (the real app)
//   • logged in but no profile           → "not invited" screen
//   • not logged in                      → LoginPage
import { useAuth } from './AuthProvider.jsx';
import { LoginPage } from './LoginPage.jsx';

export function AuthGate({ children }) {
  const { user, profile, loading, authEnabled } = useAuth();

  if (!authEnabled) return children;
  if (loading) return <CenterMsg text="Loading…" />;
  if (!user) return <LoginPage />;
  if (!profile) return <CenterMsg text="Your account isn't linked to an organisation. Ask your admin to invite you." />;
  return children;
}

function CenterMsg({ text }) {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: '#0C0B1A',
      color: '#EDE9F5',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
      fontSize: 14,
      padding: 24,
      textAlign: 'center',
    }}>
      {text}
    </div>
  );
}
