import { useState, useRef, useCallback, useEffect } from 'react';
import { runTranslatePipeline } from './pipeline.js';
import { playBase64Audio } from './api/sarvam.js';

// ─── Language pairs ───────────────────────────────────────────────────────────
const LANGUAGE_PAIRS = [
  {
    id: 'hi-te',
    labelA: 'हिंदी',
    subA: 'Hindi',
    labelB: 'తెలుగు',
    subB: 'Telugu',
    codeA: 'hi-IN',
    codeB: 'te-IN',
  },
  {
    id: 'en-te',
    labelA: 'English',
    subA: 'English',
    labelB: 'తెలుగు',
    subB: 'Telugu',
    codeA: 'en-IN',
    codeB: 'te-IN',
  },
];

const STEP_ICONS = { stt: '🎤', translate: '🔄', tts: '🔊', playing: '▶️', done: '' };

// ─── Root App ────────────────────────────────────────────────────────────────
export default function App() {
  const isProd = import.meta.env.PROD;
  const storedKey = !isProd && typeof localStorage !== 'undefined' ? localStorage.getItem('sarvam_key') || '' : '';
  const [apiKey, setApiKey] = useState(isProd ? '' : (import.meta.env.VITE_SARVAM_API_KEY || storedKey));
  const [showSetup, setShowSetup] = useState(!isProd && !apiKey);

  const [pair, setPair] = useState(LANGUAGE_PAIRS[0]);
  const [recording, setRecording] = useState(null); // 'a' | 'b' | null
  const [processing, setProcessing] = useState(false);
  const [stepMsg, setStepMsg] = useState('');
  const [stepId, setStepId] = useState('');
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState('');

  const mediaRecRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const conversationEndRef = useRef(null);

  // Auto-scroll to latest message
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, processing]);

  // Block context menu on mobile long-press
  useEffect(() => {
    const block = (e) => e.preventDefault();
    document.addEventListener('contextmenu', block);
    return () => document.removeEventListener('contextmenu', block);
  }, []);

  const handleSaveKey = (key) => {
    setApiKey(key);
    try { localStorage.setItem('sarvam_key', key); } catch {}
    setShowSetup(false);
  };

  const startRecording = useCallback(async (speaker) => {
    if (processing || recording) return;
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start(100);
      mediaRecRef.current = recorder;
      setRecording(speaker);
    } catch {
      setError('Microphone access denied. Please allow microphone access in browser settings.');
    }
  }, [processing, recording]);

  const stopRecording = useCallback(async (speaker) => {
    if (!mediaRecRef.current || recording !== speaker) return;

    setRecording(null);
    setProcessing(true);

    // Wait for recorder to flush
    await new Promise((resolve) => {
      mediaRecRef.current.onstop = resolve;
      mediaRecRef.current.stop();
    });
    streamRef.current?.getTracks().forEach((t) => t.stop());

    const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
    if (audioBlob.size < 1000) {
      setError('Recording too short. Hold the button while speaking.');
      setProcessing(false);
      return;
    }

    const sourceLang = speaker === 'a' ? pair.codeA : pair.codeB;
    const targetLang = speaker === 'a' ? pair.codeB : pair.codeA;

    try {
      const result = await runTranslatePipeline({
        audioBlob,
        sourceLang,
        targetLang,
        speaker,
        apiKey,
        onStep: (id, msg) => { setStepId(id); setStepMsg(msg); },
      });

      setMessages((prev) => [
        ...prev,
        {
          id: Date.now(),
          speaker,
          sourceLabel: speaker === 'a' ? `${pair.labelA} (${pair.subA})` : `${pair.labelB} (${pair.subB})`,
          targetLabel: speaker === 'a' ? `${pair.labelB} (${pair.subB})` : `${pair.labelA} (${pair.subA})`,
          pivotText: result.pivotText,
          translatedText: result.translatedText,
          audioB64: result.audioB64,
          sourceLang,
          targetLang,
        },
      ]);
    } catch (err) {
      setError(err.message);
    } finally {
      setProcessing(false);
      setStepId('');
      setStepMsg('');
    }
  }, [recording, pair, apiKey]);

  if (showSetup) {
    return <SetupScreen onSave={handleSaveKey} existingKey={apiKey} />;
  }

  return (
    <div style={s.root}>
      {/* ── Top Bar ── */}
      <header style={s.topBar}>
        <div style={s.logoWrap}>
          <span style={s.logoIcon}>𝕍</span>
          <div>
            <div style={s.logoName}>VaakSetu</div>
            <div style={s.logoSub}>Voice Translator</div>
          </div>
        </div>

        <div style={s.pairTabs}>
          {LANGUAGE_PAIRS.map((p) => (
            <button
              key={p.id}
              style={{ ...s.pairTab, ...(pair.id === p.id ? s.pairTabActive : {}) }}
              onClick={() => { setPair(p); setMessages([]); setError(''); }}
            >
              {p.subA} ↔ {p.subB}
            </button>
          ))}
        </div>

        {!isProd && <button style={s.gearBtn} title="Settings" onClick={() => setShowSetup(true)}>⚙</button>}
      </header>

      {/* ── Conversation ── */}
      <div style={s.feed}>
        {messages.length === 0 && !processing && (
          <div style={s.empty}>
            <div style={s.emptyOrb}>🗣️</div>
            <p style={s.emptyTitle}>Ready to translate</p>
            <p style={s.emptySub}>
              Hold <span style={{ color: COLORS.amber }}>Person A</span> or{' '}
              <span style={{ color: COLORS.teal }}>Person B</span> button and speak.
              <br />Release to hear the translation.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {processing && (
          <div style={s.processingRow}>
            <span style={s.processingIcon}>{STEP_ICONS[stepId] || '⏳'}</span>
            <span style={s.processingText}>{stepMsg || 'Processing…'}</span>
          </div>
        )}

        {error && (
          <div style={s.errorBubble}>
            ⚠️ {error}
            <button style={s.errorDismiss} onClick={() => setError('')}>✕</button>
          </div>
        )}

        <div ref={conversationEndRef} />
      </div>

      {/* ── Controls ── */}
      <div style={s.controls}>
        <SpeakerButton
          label={pair.labelA}
          sub={pair.subA}
          color={COLORS.amber}
          isRecording={recording === 'a'}
          disabled={processing || recording === 'b'}
          onStart={() => startRecording('a')}
          onStop={() => stopRecording('a')}
        />

        <div style={s.divider} />

        <SpeakerButton
          label={pair.labelB}
          sub={pair.subB}
          color={COLORS.teal}
          isRecording={recording === 'b'}
          disabled={processing || recording === 'a'}
          onStart={() => startRecording('b')}
          onStop={() => stopRecording('b')}
        />
      </div>
    </div>
  );
}

// ─── Speaker Button ──────────────────────────────────────────────────────────
function SpeakerButton({ label, sub, color, isRecording, disabled, onStart, onStop }) {
  return (
    <div style={s.speakerWrap}>
      <p style={{ ...s.speakerLabel, color }}>{label}</p>
      <p style={s.speakerSub}>{sub}</p>

      <div style={{ position: 'relative' }}>
        {/* Pulse ring while recording */}
        {isRecording && (
          <>
            <div style={{ ...s.pulseRing, borderColor: color, animationDelay: '0s' }} />
            <div style={{ ...s.pulseRing, borderColor: color, animationDelay: '0.4s' }} />
          </>
        )}
        <button
          style={{
            ...s.micBtn,
            background: isRecording ? color : `${color}18`,
            borderColor: color,
            color: isRecording ? '#0C0B1A' : color,
            opacity: disabled && !isRecording ? 0.35 : 1,
            cursor: disabled && !isRecording ? 'not-allowed' : 'pointer',
            transform: isRecording ? 'scale(1.08)' : 'scale(1)',
            boxShadow: isRecording ? `0 0 28px ${color}60` : `0 0 0px transparent`,
          }}
          onMouseDown={(e) => { e.preventDefault(); if (!disabled) onStart(); }}
          onMouseUp={(e) => { e.preventDefault(); onStop(); }}
          onMouseLeave={(e) => { e.preventDefault(); if (isRecording) onStop(); }}
          onTouchStart={(e) => { e.preventDefault(); if (!disabled) onStart(); }}
          onTouchEnd={(e) => { e.preventDefault(); onStop(); }}
          disabled={disabled && !isRecording}
        >
          <span style={{ fontSize: '1.8rem', lineHeight: 1 }}>{isRecording ? '⏹' : '🎤'}</span>
          <span style={s.micBtnLabel}>
            {isRecording ? 'Recording…' : 'Hold to Speak'}
          </span>
        </button>
      </div>
    </div>
  );
}

// ─── Message Bubble ──────────────────────────────────────────────────────────
function MessageBubble({ msg }) {
  const isA = msg.speaker === 'a';
  const accentColor = isA ? COLORS.amber : COLORS.teal;
  const [replaying, setReplaying] = useState(false);

  const handleReplay = async () => {
    if (!msg.audioB64 || replaying) return;
    setReplaying(true);
    try { await playBase64Audio(msg.audioB64); } finally { setReplaying(false); }
  };

  return (
    <div style={{ ...s.bubble, alignSelf: isA ? 'flex-start' : 'flex-end', animationDelay: '0s' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ ...s.bubbleSpeaker, color: accentColor, marginBottom: 0 }}>
          {msg.sourceLabel}
          <span style={s.arrowTag}> → {msg.targetLabel}</span>
        </div>
        {msg.audioB64 && (
          <button
            onClick={handleReplay}
            disabled={replaying}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'transparent',
              border: `1px solid ${accentColor}`,
              borderRadius: 16,
              padding: '3px 10px',
              cursor: replaying ? 'default' : 'pointer',
              color: replaying ? COLORS.muted : accentColor,
              fontSize: '0.72rem',
              fontFamily: "'DM Sans', sans-serif",
              flexShrink: 0,
            }}
          >
            {replaying ? '⏳ Playing…' : '🔊 Replay'}
          </button>
        )}
      </div>

      {msg.pivotText && msg.sourceLang !== 'en-IN' && (
        <div style={s.bubblePivot}>
          <span style={s.pivotLabel}>English: </span>{msg.pivotText}
        </div>
      )}

      <div style={s.bubbleMain}>{msg.translatedText}</div>
    </div>
  );
}

// ─── Setup / API Key Screen ──────────────────────────────────────────────────
function SetupScreen({ onSave, existingKey }) {
  const [key, setKey] = useState(existingKey || '');
  const valid = key.trim().length > 20;

  return (
    <div style={s.setupRoot}>
      <div style={s.setupCard}>
        <div style={s.setupLogo}>𝕍</div>
        <h1 style={s.setupTitle}>VaakSetu</h1>
        <p style={s.setupSub}>Bidirectional voice translator for Indian languages</p>

        <div style={s.setupDivider} />

        <label style={s.setupLabel}>Sarvam AI API Key</label>
        <input
          style={s.setupInput}
          type="password"
          placeholder="sk_…"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && valid && onSave(key.trim())}
          autoFocus
        />
        <p style={s.setupHint}>
          Get your key at{' '}
          <a href="https://dashboard.sarvam.ai" target="_blank" rel="noreferrer" style={{ color: COLORS.amber }}>
            dashboard.sarvam.ai
          </a>
        </p>

        <button
          style={{ ...s.setupBtn, opacity: valid ? 1 : 0.4, cursor: valid ? 'pointer' : 'default' }}
          onClick={() => valid && onSave(key.trim())}
        >
          Start Translating →
        </button>
      </div>
    </div>
  );
}

// ─── Design tokens ────────────────────────────────────────────────────────────
const COLORS = {
  bg: '#0C0B1A',
  surface: '#15132B',
  border: '#26234A',
  amber: '#F5A623',
  teal: '#0FB8A9',
  text: '#EDE9FF',
  muted: '#6E6A9A',
};

// ─── Styles ──────────────────────────────────────────────────────────────────
const s = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
    background: COLORS.bg,
    color: COLORS.text,
    fontFamily: "'DM Sans', sans-serif",
    overflow: 'hidden',
  },

  // Top bar
  topBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 18px',
    borderBottom: `1px solid ${COLORS.border}`,
    flexShrink: 0,
    gap: 12,
  },
  logoWrap: { display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 },
  logoIcon: { fontSize: '1.6rem', color: COLORS.amber, fontFamily: "'Crimson Pro', serif" },
  logoName: { fontFamily: "'Crimson Pro', serif", fontSize: '1.1rem', fontWeight: 700, color: COLORS.amber, lineHeight: 1.1 },
  logoSub: { fontSize: '0.65rem', color: COLORS.muted, letterSpacing: '0.07em', textTransform: 'uppercase' },
  pairTabs: { display: 'flex', gap: 6 },
  pairTab: {
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 20,
    padding: '4px 12px',
    color: COLORS.muted,
    fontSize: '0.75rem',
    cursor: 'pointer',
    fontFamily: "'DM Sans', sans-serif",
    transition: 'all 0.15s',
  },
  pairTabActive: {
    borderColor: COLORS.amber,
    color: COLORS.amber,
    background: `${COLORS.amber}18`,
  },
  gearBtn: {
    background: 'transparent',
    border: 'none',
    color: COLORS.muted,
    fontSize: '1.1rem',
    cursor: 'pointer',
    padding: 4,
    flexShrink: 0,
  },

  // Conversation feed
  feed: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 18px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    scrollBehavior: 'smooth',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    gap: 12,
    opacity: 0.5,
    textAlign: 'center',
  },
  emptyOrb: { fontSize: '3rem' },
  emptyTitle: { fontFamily: "'Crimson Pro', serif", fontSize: '1.3rem', color: COLORS.text },
  emptySub: { color: COLORS.muted, fontSize: '0.875rem', lineHeight: 1.7, maxWidth: 280 },

  // Message bubbles
  bubble: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 14,
    padding: '12px 16px',
    maxWidth: '82%',
    animation: 'fade-up 0.25s ease forwards',
  },
  bubbleSpeaker: {
    fontSize: '0.7rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 8,
  },
  arrowTag: { color: COLORS.muted, fontWeight: 400 },
  bubblePivot: {
    fontSize: '0.82rem',
    color: COLORS.muted,
    fontStyle: 'italic',
    marginBottom: 8,
    paddingBottom: 8,
    borderBottom: `1px solid ${COLORS.border}`,
  },
  pivotLabel: { fontStyle: 'normal', fontWeight: 600 },
  bubbleMain: {
    fontSize: '1rem',
    lineHeight: 1.55,
    color: COLORS.text,
  },

  // Processing row
  processingRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 16px',
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 12,
    alignSelf: 'center',
    fontSize: '0.875rem',
    color: COLORS.muted,
    animation: 'fade-up 0.2s ease forwards',
  },
  processingIcon: { fontSize: '1rem' },
  processingText: {},

  // Error
  errorBubble: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    padding: '10px 14px',
    background: '#2A0E0E',
    border: '1px solid #5C2020',
    borderRadius: 12,
    color: '#FF7A7A',
    fontSize: '0.85rem',
    alignSelf: 'stretch',
  },
  errorDismiss: {
    background: 'none',
    border: 'none',
    color: '#FF7A7A',
    cursor: 'pointer',
    fontSize: '0.85rem',
    flexShrink: 0,
  },

  // Controls
  controls: {
    display: 'flex',
    borderTop: `1px solid ${COLORS.border}`,
    flexShrink: 0,
    background: COLORS.surface,
  },
  divider: {
    width: 1,
    background: COLORS.border,
    flexShrink: 0,
    margin: '16px 0',
  },
  speakerWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '16px 12px 20px',
    gap: 4,
  },
  speakerLabel: {
    fontFamily: "'Crimson Pro', serif",
    fontSize: '1.1rem',
    fontWeight: 600,
    margin: 0,
  },
  speakerSub: {
    fontSize: '0.65rem',
    color: COLORS.muted,
    margin: '0 0 8px',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  micBtn: {
    width: 86,
    height: 86,
    borderRadius: '50%',
    border: '2.5px solid',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    transition: 'all 0.15s ease',
    userSelect: 'none',
    touchAction: 'none',
    WebkitTapHighlightColor: 'transparent',
    outline: 'none',
  },
  micBtnLabel: {
    fontSize: '0.6rem',
    letterSpacing: '0.04em',
    textAlign: 'center',
    lineHeight: 1.2,
    maxWidth: 64,
  },
  pulseRing: {
    position: 'absolute',
    inset: -4,
    borderRadius: '50%',
    border: '2px solid',
    animation: 'pulse-ring 1.2s ease-out infinite',
    pointerEvents: 'none',
  },

  // Setup screen
  setupRoot: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    background: COLORS.bg,
    padding: 24,
  },
  setupCard: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 20,
    padding: '36px 32px',
    width: '100%',
    maxWidth: 380,
    textAlign: 'center',
  },
  setupLogo: {
    fontFamily: "'Crimson Pro', serif",
    fontSize: '3.5rem',
    color: COLORS.amber,
    lineHeight: 1,
    marginBottom: 12,
  },
  setupTitle: {
    fontFamily: "'Crimson Pro', serif",
    fontSize: '1.8rem',
    color: COLORS.text,
    marginBottom: 6,
  },
  setupSub: {
    color: COLORS.muted,
    fontSize: '0.875rem',
    lineHeight: 1.5,
  },
  setupDivider: {
    height: 1,
    background: COLORS.border,
    margin: '24px 0',
  },
  setupLabel: {
    display: 'block',
    textAlign: 'left',
    fontSize: '0.8rem',
    fontWeight: 600,
    color: COLORS.muted,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 8,
  },
  setupInput: {
    display: 'block',
    width: '100%',
    padding: '12px 14px',
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    color: COLORS.text,
    fontSize: '0.95rem',
    fontFamily: 'monospace',
    marginBottom: 8,
    outline: 'none',
  },
  setupHint: {
    fontSize: '0.78rem',
    color: COLORS.muted,
    marginBottom: 24,
    textAlign: 'left',
  },
  setupBtn: {
    display: 'block',
    width: '100%',
    padding: '13px',
    background: COLORS.amber,
    border: 'none',
    borderRadius: 10,
    color: '#0C0B1A',
    fontWeight: 700,
    fontSize: '1rem',
    fontFamily: "'DM Sans', sans-serif",
    letterSpacing: '0.02em',
    transition: 'opacity 0.15s',
  },
};
