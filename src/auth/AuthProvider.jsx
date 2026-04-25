// Auth state lives here. Exposes `user`, `profile` (org + role), `loading`,
// and a `signOut` action through a React context. When Supabase isn't
// configured (`authEnabled === false`) the provider becomes a pass-through
// so the rest of the app doesn't need to special-case local dev without auth.
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase, authEnabled } from '../lib/supabase';

const AuthContext = createContext({
  user: null,
  profile: null,
  loading: false,
  authEnabled: false,
  signOut: async () => {},
});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(authEnabled);

  const loadProfile = useCallback(async (uid) => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, role, org_id, orgs(id, name, plan, monthly_minute_cap)')
      .eq('id', uid)
      .single();
    if (error) {
      // Common cause: user signed up but isn't invited → the DB trigger
      // blocked profile creation. Sign them out so they can try again.
      console.warn('[auth] profile load failed:', error.message);
      await supabase.auth.signOut();
      setProfile(null);
    } else {
      setProfile(data);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authEnabled) { setLoading(false); return; }

    // Restore existing session on mount.
    supabase.auth.getSession().then(({ data }) => {
      const u = data.session?.user || null;
      setUser(u);
      if (u) loadProfile(u.id);
      else setLoading(false);
    });

    // Subscribe to auth state changes (login / logout / token refresh).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user || null;
      setUser(u);
      if (u) loadProfile(u.id);
      else { setProfile(null); setLoading(false); }
    });
    return () => subscription.unsubscribe();
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    if (!authEnabled) return;
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, profile, loading, authEnabled, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
