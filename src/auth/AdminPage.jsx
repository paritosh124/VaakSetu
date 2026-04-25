// Basic admin dashboard: rolling per-user usage + recent events.
// Only reachable when the signed-in user's profile.role === 'admin'.
// RLS ensures non-admins can't read rows even if they bypass the router.
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthProvider';

export function AdminPage({ onClose }) {
  const { profile } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const since = new Date();
        since.setDate(since.getDate() - 30);

        // Two queries + JS merge — usage_events.user_id has its FK on
        // auth.users, not on public.profiles, so PostgREST can't auto-join.
        const [eventsResp, profilesResp] = await Promise.all([
          supabase
            .from('usage_events')
            .select('id, user_id, event_type, provider, source_lang, target_lang, chars, duration_ms, api_cost_cents, created_at')
            .eq('org_id', profile.org_id)
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: false })
            .limit(500),
          supabase
            .from('profiles')
            .select('id, email')
            .eq('org_id', profile.org_id),
        ]);
        if (eventsResp.error)   throw eventsResp.error;
        if (profilesResp.error) throw profilesResp.error;

        const emailById = Object.fromEntries((profilesResp.data || []).map((p) => [p.id, p.email]));
        const enriched = (eventsResp.data || []).map((e) => ({ ...e, email: emailById[e.user_id] || e.user_id.slice(0, 8) }));
        setRows(enriched);
      } catch (e) {
        setErr(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [profile.org_id]);

  const summary = useMemo(() => {
    const byUser = {};
    let totalEvents = 0;
    let totalCents  = 0;
    let totalMs     = 0;
    for (const r of rows) {
      const key = r.email;
      const u = byUser[key] || { email: key, events: 0, cents: 0, duration_ms: 0 };
      u.events += 1;
      u.cents  += r.api_cost_cents || 0;
      u.duration_ms += r.duration_ms || 0;
      byUser[key] = u;
      totalEvents += 1;
      totalCents  += r.api_cost_cents || 0;
      totalMs     += r.duration_ms || 0;
    }
    return {
      perUser: Object.values(byUser).sort((a, b) => b.cents - a.cents),
      totalEvents, totalCents, totalMs,
    };
  }, [rows]);

  return (
    <div style={s.root}>
      <div style={s.header}>
        <h1 style={s.title}>Usage — last 30 days</h1>
        <button style={s.closeBtn} onClick={onClose}>Close</button>
      </div>

      {loading && <p style={s.dim}>Loading…</p>}
      {err && <p style={{ ...s.dim, color: '#E5484D' }}>Error: {err}</p>}

      {!loading && !err && (
        <>
          <div style={s.tiles}>
            <Tile label="Events"   value={summary.totalEvents} />
            <Tile label="Cost"     value={`~$${(summary.totalCents / 100).toFixed(2)}`} />
            <Tile label="Audio (minutes)" value={(summary.totalMs / 60000).toFixed(1)} />
          </div>

          <h2 style={s.h2}>By user</h2>
          <table style={s.table}>
            <thead>
              <tr style={s.tr}>
                <th style={s.th}>Email</th>
                <th style={s.thN}>Events</th>
                <th style={s.thN}>Cost</th>
                <th style={s.thN}>Minutes</th>
              </tr>
            </thead>
            <tbody>
              {summary.perUser.map((u) => (
                <tr key={u.email} style={s.tr}>
                  <td style={s.td}>{u.email}</td>
                  <td style={s.tdN}>{u.events}</td>
                  <td style={s.tdN}>~${(u.cents / 100).toFixed(2)}</td>
                  <td style={s.tdN}>{(u.duration_ms / 60000).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2 style={s.h2}>Latest events</h2>
          <table style={s.table}>
            <thead>
              <tr style={s.tr}>
                <th style={s.th}>Time</th>
                <th style={s.th}>User</th>
                <th style={s.th}>Type</th>
                <th style={s.th}>Provider</th>
                <th style={s.th}>Src → Tgt</th>
                <th style={s.thN}>Chars</th>
                <th style={s.thN}>ms</th>
                <th style={s.thN}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 100).map((r) => (
                <tr key={r.id} style={s.tr}>
                  <td style={s.td}>{new Date(r.created_at).toLocaleString()}</td>
                  <td style={s.td}>{r.email}</td>
                  <td style={s.td}>{r.event_type}</td>
                  <td style={s.td}>{r.provider || '-'}</td>
                  <td style={s.td}>{r.source_lang || '-'} → {r.target_lang || '-'}</td>
                  <td style={s.tdN}>{r.chars ?? '-'}</td>
                  <td style={s.tdN}>{r.duration_ms ?? '-'}</td>
                  <td style={s.tdN}>{r.api_cost_cents != null ? `~${r.api_cost_cents}¢` : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function Tile({ label, value }) {
  return (
    <div style={s.tile}>
      <div style={s.tileLabel}>{label}</div>
      <div style={s.tileValue}>{value}</div>
    </div>
  );
}

const s = {
  root: {
    position: 'fixed', inset: 0, zIndex: 9999,
    background: '#0C0B1A', color: '#EDE9F5',
    fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    overflow: 'auto', padding: 24,
  },
  header:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  title:    { margin: 0, fontSize: 22, color: '#F5A623' },
  closeBtn: { padding: '6px 12px', borderRadius: 8, border: '1px solid #2a2750', background: '#151329', color: '#EDE9F5', cursor: 'pointer' },
  dim:      { color: '#8E8AA0' },
  tiles:    { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 },
  tile:     { background: '#151329', borderRadius: 10, padding: 14, border: '1px solid #2a2750' },
  tileLabel:{ fontSize: 11, color: '#8E8AA0', textTransform: 'uppercase', letterSpacing: 0.5 },
  tileValue:{ fontSize: 22, fontWeight: 700, marginTop: 4 },
  h2:       { fontSize: 14, color: '#8E8AA0', textTransform: 'uppercase', letterSpacing: 0.5, margin: '22px 0 8px' },
  table:    { width: '100%', borderCollapse: 'collapse', background: '#151329', borderRadius: 10, overflow: 'hidden', fontSize: 12 },
  tr:       { borderBottom: '1px solid #2a2750' },
  th:       { textAlign: 'left',  padding: '10px 12px', color: '#8E8AA0', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' },
  thN:      { textAlign: 'right', padding: '10px 12px', color: '#8E8AA0', fontWeight: 600, fontSize: 11, textTransform: 'uppercase' },
  td:       { padding: '9px 12px' },
  tdN:      { padding: '9px 12px', textAlign: 'right' },
};
