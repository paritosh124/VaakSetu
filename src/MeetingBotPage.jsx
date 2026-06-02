import { useState, useRef, useCallback, useEffect } from 'react';
import { wakeRelay, createBot, stopBot, connectAgentSocket } from './api/bot.js';
import { playBase64Audio, unlockAudio } from './api/sarvam.js';

// Combined language list (Indian Sarvam + a few intl). Codes match the relay's
// routing in config.js / pipeline-node.js.
const LANGS = [
  { code: 'hi-IN', label: 'Hindi' },
  { code: 'en-IN', label: 'English' },
  { code: 'bn-IN', label: 'Bengali' },
  { code: 'gu-IN', label: 'Gujarati' },
  { code: 'kn-IN', label: 'Kannada' },
  { code: 'ml-IN', label: 'Malayalam' },
  { code: 'mr-IN', label: 'Marathi' },
  { code: 'pa-IN', label: 'Punjabi' },
  { code: 'ta-IN', label: 'Tamil' },
  { code: 'te-IN', label: 'Telugu' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ar', label: 'Arabic' },
  { code: 'zh', label: 'Chinese' },
];

// Status → display text.
const STATUS_TEXT = {
  idle:                 'Ready',
  waking:               'Waking translation server… (free tier cold start, up to ~1 min)',
  'creating-room':      'Setting up the call…',
  'waiting-for-customer': 'Waiting for the customer to join…',
  live:                 '● Live — translating',
  'customer-left':      'Customer left the call',
  reconnecting:         'Connection dropped, reconnecting…',
  error:                'Error',
  ended:                'Call ended',
};

export function MeetingBotPage() {
  const [agentLang, setAgentLang]     = useState('en-IN');
  const [customerLang, setCustomerLang] = useState('hi-IN');
  const [status, setStatus]   = useState('idle');
  const [detail, setDetail]   = useState('');
  const [wakeSecs, setWakeSecs] = useState(0);
  const [customerUrl, setCustomerUrl] = useState('');
  const [copied, setCopied]   = useState(false);
  const [feed, setFeed]       = useState([]); // { who, pivotEn, text, ts }
  const [recording, setRecording] = useState(false);

  const sockRef    = useRef(null);   // { ws, sendUtterance }
  const sessionRef = useRef(null);   // { sessionId, roomName, customerUrl }
  const mediaRef   = useRef(null);   // { recorder, stream, chunks }
  const feedEndRef = useRef(null);

  useEffect(() => { feedEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [feed]);
  useEffect(() => () => cleanup(), []); // unmount

  const live = status === 'live';
  // Session is active from creation onward (covers waiting-for-customer too).
  const sessionActive = ['creating-room', 'waiting-for-customer', 'live', 'customer-left', 'reconnecting'].includes(status);

  const addFeed = useCallback((entry) => setFeed((f) => [...f, entry]), []);

  function cleanup() {
    try { sockRef.current?.ws?.close(); } catch {}
    try { mediaRef.current?.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    sockRef.current = null;
    mediaRef.current = null;
  }

  async function handleStart() {
    unlockAudio(); // pre-warm AudioContext within the user gesture

    // 1) Wake the relay (cold start) first.
    setStatus('waking'); setDetail('');
    let awake = false;
    try { awake = await wakeRelay((s) => setWakeSecs(s)); }
    catch (e) { setStatus('error'); setDetail(e.message); return; }
    if (!awake) { setStatus('error'); setDetail('Translation server did not wake up. Tap Retry.'); return; }

    // 2) Create the room + customer link.
    setStatus('creating-room');
    let session;
    try { session = await createBot({ agentLang, customerLang }); }
    catch (e) { setStatus('error'); setDetail(e.message); return; }
    sessionRef.current = session;
    setCustomerUrl(session.customerUrl);

    // 3) Connect the agent socket. The relay reports room status over it.
    setStatus('waiting-for-customer');
    sockRef.current = connectAgentSocket(session.sessionId, {
      onStatus: (state) => setStatus(state),
      onTranscript: (m) => addFeed({ who: m.who, pivotEn: m.pivotEn, text: m.text, ts: m.ts }),
      onAudio: (m) => { if (m.who === 'customer' && m.data) playBase64Audio(m.data).catch(() => {}); },
      onError: (msg) => { setStatus('error'); setDetail(msg); },
      onClose: () => { if (sessionRef.current) setStatus('reconnecting'); },
    });
  }

  async function handleStop() {
    const session = sessionRef.current;
    cleanup();
    setStatus('ended'); setCustomerUrl('');
    if (session) await stopBot(session).catch(() => {});
    sessionRef.current = null;
  }

  function copyLink() {
    navigator.clipboard?.writeText(customerUrl).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    });
  }

  // Agent push-to-talk: hold → record mic, release → send utterance to relay.
  async function startTalk() {
    if (!sessionActive || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: pickMime() });
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType });
        if (blob.size > 1000) await sockRef.current?.sendUtterance(blob);
      };
      recorder.start();
      mediaRef.current = { recorder, stream, chunks };
      setRecording(true);
    } catch (e) {
      setDetail(`Mic error: ${e.message}`);
    }
  }
  function stopTalk() {
    if (!recording) return;
    try { mediaRef.current?.recorder?.stop(); } catch {}
    setRecording(false);
  }

  return (
    <div style={S.page}>
      <h1 style={S.h1}>VaakSetu — Live Call</h1>
      <p style={S.note}>
        Pick your languages, start the call, and send the customer the link.
        They join in their browser — no install. You'll hear them in your
        language; hold the button to speak and they'll hear you in theirs.
      </p>

      <div style={S.row}>
        <label style={S.label}>You speak
          <select style={S.select} value={agentLang} onChange={(e) => setAgentLang(e.target.value)} disabled={sessionActive}>
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
        <label style={S.label}>Customer speaks
          <select style={S.select} value={customerLang} onChange={(e) => setCustomerLang(e.target.value)} disabled={sessionActive}>
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </select>
        </label>
      </div>

      <div style={{ ...S.status, color: status === 'error' ? '#ff6b6b' : live ? '#0FB8A9' : '#F5A623' }}>
        {STATUS_TEXT[status] || status}
        {status === 'waking' && ` (${wakeSecs}s)`}
        {detail && <div style={S.detail}>{detail}</div>}
      </div>

      {customerUrl && (
        <div style={S.linkBox}>
          <div style={S.linkLabel}>Send this link to your customer:</div>
          <div style={S.linkRow}>
            <input style={S.linkInput} readOnly value={customerUrl} onFocus={(e) => e.target.select()} />
            <button style={S.copy} onClick={copyLink}>{copied ? 'Copied!' : 'Copy'}</button>
          </div>
        </div>
      )}

      <div style={S.controls}>
        {!sessionActive && status !== 'waking' ? (
          <button style={S.start} onClick={handleStart}>
            {status === 'error' || status === 'ended' ? 'Retry' : 'Start Call'}
          </button>
        ) : status !== 'waking' ? (
          <button style={S.stop} onClick={handleStop}>End Call</button>
        ) : null}
        {sessionActive && (
          <button
            style={{ ...S.talk, background: recording ? '#ff6b6b' : '#F5A623' }}
            onMouseDown={startTalk} onMouseUp={stopTalk}
            onTouchStart={(e) => { e.preventDefault(); startTalk(); }}
            onTouchEnd={(e) => { e.preventDefault(); stopTalk(); }}
          >
            {recording ? 'Recording…' : 'Hold to Speak'}
          </button>
        )}
      </div>

      <div style={S.feed}>
        {feed.map((m, i) => (
          <div key={i} style={{ ...S.bubble, alignSelf: m.who === 'agent' ? 'flex-end' : 'flex-start',
                                 background: m.who === 'agent' ? '#1b3a37' : '#3a2f12' }}>
            <div style={S.who}>{m.who === 'agent' ? 'You → customer' : 'Customer → you'}</div>
            <div>{m.text}</div>
            {m.pivotEn && m.pivotEn !== m.text && <div style={S.pivot}>{m.pivotEn}</div>}
          </div>
        ))}
        <div ref={feedEndRef} />
      </div>
    </div>
  );
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  return '';
}

const S = {
  page: { maxWidth: 720, margin: '0 auto', padding: 24, color: '#EDEBF5', fontFamily: 'DM Sans, sans-serif' },
  h1: { fontFamily: 'Crimson Pro, serif', fontSize: 32, marginBottom: 8 },
  note: { color: '#A9A6BE', fontSize: 14, lineHeight: 1.5, marginBottom: 20 },
  row: { display: 'flex', gap: 12, marginBottom: 12, flexWrap: 'wrap' },
  label: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: '#A9A6BE' },
  select: { padding: '8px 10px', borderRadius: 8, border: '1px solid #2a2840', background: '#15132a', color: '#EDEBF5' },
  status: { margin: '16px 0', fontWeight: 600 },
  detail: { fontSize: 13, fontWeight: 400, color: '#A9A6BE', marginTop: 4 },
  linkBox: { background: '#15132a', border: '1px solid #2a2840', borderRadius: 10, padding: 14, marginBottom: 18 },
  linkLabel: { fontSize: 13, color: '#A9A6BE', marginBottom: 8 },
  linkRow: { display: 'flex', gap: 8 },
  linkInput: { flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #2a2840', background: '#0C0B1A', color: '#EDEBF5', fontSize: 13 },
  copy: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#0FB8A9', color: '#04201d', fontWeight: 700, cursor: 'pointer' },
  controls: { display: 'flex', gap: 12, marginBottom: 20 },
  start: { padding: '12px 24px', borderRadius: 10, border: 'none', background: '#0FB8A9', color: '#04201d', fontWeight: 700, cursor: 'pointer' },
  stop: { padding: '12px 24px', borderRadius: 10, border: 'none', background: '#ff6b6b', color: '#2a0b0b', fontWeight: 700, cursor: 'pointer' },
  talk: { padding: '12px 24px', borderRadius: 10, border: 'none', color: '#2a1a00', fontWeight: 700, cursor: 'pointer', userSelect: 'none', touchAction: 'none' },
  feed: { display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 360, overflowY: 'auto', padding: 8 },
  bubble: { maxWidth: '80%', padding: '10px 14px', borderRadius: 12, fontSize: 15, userSelect: 'text' },
  who: { fontSize: 11, color: '#A9A6BE', marginBottom: 4 },
  pivot: { fontSize: 12, color: '#8a87a0', fontStyle: 'italic', marginTop: 4 },
};
