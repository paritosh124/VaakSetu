import { useState, useRef, useCallback, useEffect } from 'react';
import { runTranslatePipeline } from './pipeline.js';
import { playBase64Audio, unlockAudio } from './api/sarvam.js';

// ─── Languages (all Sarvam-supported) ────────────────────────────────────────
const LANGUAGES = [
  { code: 'hi-IN', name: 'Hindi',     native: 'हिंदी'    },
  { code: 'en-IN', name: 'English',   native: 'English'  },
  { code: 'bn-IN', name: 'Bengali',   native: 'বাংলা'    },
  { code: 'gu-IN', name: 'Gujarati',  native: 'ગુજરાતી'  },
  { code: 'kn-IN', name: 'Kannada',   native: 'ಕನ್ನಡ'    },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം'  },
  { code: 'mr-IN', name: 'Marathi',   native: 'मराठी'    },
  { code: 'od-IN', name: 'Odia',      native: 'ଓଡ଼ିଆ'    },
  { code: 'pa-IN', name: 'Punjabi',   native: 'ਪੰਜਾਬੀ'   },
  { code: 'ta-IN', name: 'Tamil',     native: 'தமிழ்'    },
  { code: 'te-IN', name: 'Telugu',    native: 'తెలుగు'   },
];

const getLang = (code) => LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];

// Bulbul v3 voices
const VOICES = {
  male:   'anand',
  female: 'ritu',
};

const STEP_ICONS = { stt: '🎤', translate: '🔄', tts: '🔊', playing: '▶️', done: '' };

// ─── Root App ────────────────────────────────────────────────────────────────
export default function App() {
  const isProd = import.meta.env.PROD;
  const storedKey = !isProd && typeof localStorage !== 'undefined' ? localStorage.getItem('sarvam_key') || '' : '';
  const [apiKey, setApiKey] = useState(isProd ? '' : (import.meta.env.VITE_SARVAM_API_KEY || storedKey));
  const [showSetup, setShowSetup] = useState(!isProd && !apiKey);

  const [langA, setLangA] = useState(() => localStorage.getItem('vs_langA') || 'hi-IN');
  const [langB, setLangB] = useState(() => localStorage.getItem('vs_langB') || 'te-IN');
  const [voiceA, setVoiceA] = useState(() => localStorage.getItem('vs_voiceA') || 'male');
  const [voiceB, setVoiceB] = useState(() => localStorage.getItem('vs_voiceB') || 'female');

  useEffect(() => { localStorage.setItem('vs_langA', langA); }, [langA]);
  useEffect(() => { localStorage.setItem('vs_langB', langB); }, [langB]);
  useEffect(() => { localStorage.setItem('vs_voiceA', voiceA); }, [voiceA]);
  useEffect(() => { localStorage.setItem('vs_voiceB', voiceB); }, [voiceB]);

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

  const startRecording = useCallback((speaker) => {
    if (processing || recording) return;
    setError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported on this browser. Try Safari 14.3+ or Chrome.');
      return;
    }

    unlockAudio(); // must be called synchronously within user gesture for iOS Safari

    // Pre-warm TCP/TLS connection to the API while user is still speaking
    const warmBase = import.meta.env.DEV ? '/sarvam/speech-to-text' : '/api/speech-to-text';
    fetch(warmBase, { method: 'HEAD' }).catch(() => {});

    navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
      streamRef.current = stream;
      // Pick a MIME type iOS Safari supports (prefers mp4, falls back to default)
      const mimeType = ['audio/mp4', 'audio/webm', ''].find(
        (t) => t === '' || MediaRecorder.isTypeSupported(t)
      );
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start(100);
      mediaRecRef.current = recorder;
      setRecording(speaker);
    }).catch((err) => {
      if (err.name === 'NotAllowedError') {
        setError('Microphone permission denied. On iPhone: Settings → Privacy → Microphone → enable Safari.');
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found on this device.');
      } else {
        setError(`Microphone error: ${err.name} — ${err.message}`);
      }
    });
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

    const rawMime = mediaRecRef.current?.mimeType || 'audio/webm';
    const mimeType = rawMime.split(';')[0]; // strip codecs e.g. "audio/mp4;codecs=opus" → "audio/mp4"
    const audioBlob = new Blob(chunksRef.current, { type: mimeType });
    if (audioBlob.size < 1000) {
      setError('Recording too short. Hold the button while speaking.');
      setProcessing(false);
      return;
    }

    const sourceLang = speaker === 'a' ? langA : langB;
    const targetLang = speaker === 'a' ? langB : langA;
    // Voice follows the LISTENER: when A speaks, B is hearing the output, so use B's voice preference
    const voice = VOICES[speaker === 'a' ? voiceB : voiceA];

    const srcLang = getLang(sourceLang);
    const tgtLang = getLang(targetLang);
    const messageId = Date.now();
    const sourceLabel = `${srcLang.native} (${srcLang.name})`;
    const targetLabel = `${tgtLang.native} (${tgtLang.name})`;

    try {
      const result = await runTranslatePipeline({
        audioBlob,
        sourceLang,
        targetLang,
        voice,
        apiKey,
        onStep: (id, msg) => { setStepId(id); setStepMsg(msg); },
        onText: (pivotText, translatedText) => {
          setMessages((prev) => [
            ...prev,
            { id: messageId, speaker, sourceLabel, targetLabel, pivotText, translatedText, sourceLang, targetLang },
          ]);
          setProcessing(false);
          setStepId('');
          setStepMsg('');
        },
      });

      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, audioB64: result.audioB64 } : m));
    } catch (err) {
      setError(err.message);
      setProcessing(false);
      setStepId('');
      setStepMsg('');
    }
  }, [recording, langA, langB, voiceA, voiceB, apiKey]);

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
        {!isProd && <button style={s.gearBtn} title="Settings" onClick={() => setShowSetup(true)}>⚙</button>}
      </header>

      {/* ── Language + Voice selectors ── */}
      <div style={s.selectorRow}>
        <PersonSelector
          color={COLORS.amber}
          label="Person A"
          lang={langA}
          voice={voiceA}
          onLangChange={(v) => { setLangA(v); setError(''); }}
          onVoiceChange={setVoiceA}
        />
        <div style={s.selectorDivider}>↔</div>
        <PersonSelector
          color={COLORS.teal}
          label="Person B"
          lang={langB}
          voice={voiceB}
          onLangChange={(v) => { setLangB(v); setError(''); }}
          onVoiceChange={setVoiceB}
        />
      </div>

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
          label={getLang(langA).native}
          sub={getLang(langA).name}
          color={COLORS.amber}
          isRecording={recording === 'a'}
          disabled={processing || recording === 'b'}
          onStart={() => startRecording('a')}
          onStop={() => stopRecording('a')}
        />

        <div style={s.divider} />

        <SpeakerButton
          label={getLang(langB).native}
          sub={getLang(langB).name}
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
// ─── Person Selector (language + voice) ──────────────────────────────────────
function PersonSelector({ color, label, lang, voice, onLangChange, onVoiceChange }) {
  return (
    <div style={s.personCol}>
      <div style={{ ...s.personLabel, color }}>{label}</div>
      <select
        style={{ ...s.langSelect, borderColor: color, color }}
        value={lang}
        onChange={(e) => onLangChange(e.target.value)}
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>{l.name} — {l.native}</option>
        ))}
      </select>
      <div style={s.voiceToggle}>
        {['male', 'female'].map((g) => (
          <button
            key={g}
            style={{
              ...s.voiceBtn,
              background: voice === g ? color : 'transparent',
              color: voice === g ? '#0C0B1A' : color,
              borderColor: color,
            }}
            onClick={() => onVoiceChange(g)}
          >
            {g === 'male' ? '♂ Male' : '♀ Female'}
          </button>
        ))}
      </div>
    </div>
  );
}

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
  // Language + voice selector row
  selectorRow: {
    display: 'flex',
    alignItems: 'stretch',
    gap: 8,
    padding: '10px 14px',
    borderBottom: `1px solid ${COLORS.border}`,
    background: COLORS.surface,
    flexShrink: 0,
  },
  selectorDivider: {
    display: 'flex',
    alignItems: 'center',
    color: COLORS.muted,
    fontSize: '1.1rem',
    flexShrink: 0,
  },
  personCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    minWidth: 0,
  },
  personLabel: {
    fontSize: '0.65rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  },
  langSelect: {
    background: COLORS.bg,
    border: '1px solid',
    borderRadius: 8,
    padding: '6px 8px',
    fontSize: '0.8rem',
    fontFamily: "'DM Sans', sans-serif",
    cursor: 'pointer',
    outline: 'none',
    width: '100%',
  },
  voiceToggle: {
    display: 'flex',
    gap: 4,
  },
  voiceBtn: {
    flex: 1,
    border: '1px solid',
    borderRadius: 6,
    padding: '4px 6px',
    fontSize: '0.7rem',
    fontFamily: "'DM Sans', sans-serif",
    cursor: 'pointer',
    fontWeight: 600,
    transition: 'all 0.15s',
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
