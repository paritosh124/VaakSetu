import { useState, useRef, useCallback, useEffect } from 'react';
import { runTranslatePipeline, speechToEnglish, englishToSpeech, runOpenAIPipeline, openaiSpeechToEnglishPipeline, openaiEnglishToSpeech, runGroqPipeline, groqSpeechToEnglishPipeline, groqEnglishToSpeech } from './pipeline.js';
import { playBase64Audio, unlockAudio } from './api/sarvam.js';
import { SarvamStreamingSTT, supportsStreamingSTT } from './api/sarvam-streaming.js';
import { Peer } from 'peerjs';
import { generateRoomCode, hostPeerId } from './peer.js';

// ─── Languages (all Sarvam-supported) ────────────────────────────────────────
const LANGUAGES = [
  { code: 'hi-IN', name: 'Hindi',     native: 'हिंदी'    },
  { code: 'en-IN', name: 'English',   native: 'English'  },
  { code: 'bn-IN', name: 'Bengali',   native: 'বাংলা'    },
  { code: 'gu-IN', name: 'Gujarati',  native: 'ગુજરાતી'  },
  { code: 'kn-IN', name: 'Kannada',   native: 'ಕನ್ನಡ'    },
  { code: 'ml-IN', name: 'Malayalam', native: 'മലയാളം'  },
  { code: 'mr-IN', name: 'Marathi',   native: 'मराठी'    },
  { code: 'or-IN', name: 'Odia',      native: 'ଓଡ଼ିଆ'    },
  { code: 'pa-IN', name: 'Punjabi',   native: 'ਪੰਜਾਬੀ'   },
  { code: 'ta-IN', name: 'Tamil',     native: 'தமிழ்'    },
  { code: 'te-IN', name: 'Telugu',    native: 'తెలుగు'   },
];

const getLang = (code) =>
  LANGUAGES.find((l) => l.code === code) ||
  INTL_LANGUAGES.find((l) => l.code === code) ||
  LANGUAGES[0];

// International (non-Indian) languages via OpenAI
const INTL_LANGUAGES = [
  { code: 'es', name: 'Spanish',    native: 'Español'           },
  { code: 'fr', name: 'French',     native: 'Français'          },
  { code: 'de', name: 'German',     native: 'Deutsch'           },
  { code: 'ja', name: 'Japanese',   native: '日本語'              },
  { code: 'zh', name: 'Chinese',    native: '中文'               },
  { code: 'ar', name: 'Arabic',     native: 'العربية'           },
  { code: 'pt', name: 'Portuguese', native: 'Português'         },
  { code: 'ru', name: 'Russian',    native: 'Русский'           },
  { code: 'it', name: 'Italian',    native: 'Italiano'          },
  { code: 'ko', name: 'Korean',     native: '한국어'              },
  { code: 'nl', name: 'Dutch',      native: 'Nederlands'        },
  { code: 'tr', name: 'Turkish',    native: 'Türkçe'            },
  { code: 'pl', name: 'Polish',     native: 'Polski'            },
  { code: 'sv', name: 'Swedish',    native: 'Svenska'           },
  { code: 'th', name: 'Thai',       native: 'ไทย'               },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt'        },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia'  },
  { code: 'uk', name: 'Ukrainian',  native: 'Українська'        },
];

const INDIAN_CODES = new Set(LANGUAGES.map((l) => l.code));
const isIndianLang = (code) => INDIAN_CODES.has(code);

// Full catalogs. Earlier we trimmed these to two pairs while optimizing
// latency / cost — restored to the complete sets now.
const PICKER_LANGUAGES      = LANGUAGES;
const PICKER_INTL_LANGUAGES = INTL_LANGUAGES;

// Bulbul v3 voices (Sarvam) — also used as gender key for OpenAI (onyx/nova)
const VOICES = {
  male:   'anand',
  female: 'ritu',
};

const STEP_ICONS = { stt: '🎤', translate: '🔄', tts: '🔊', playing: '▶️', done: '' };

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

// ─── Root App ────────────────────────────────────────────────────────────────
export default function App() {
  const isProd = import.meta.env.PROD;
  const storedKey = !isProd && typeof localStorage !== 'undefined' ? localStorage.getItem('sarvam_key') || '' : '';
  const storedOAIKey     = !isProd ? localStorage.getItem('openai_key')     || '' : '';
  const storedGroqKey    = !isProd ? localStorage.getItem('groq_key')       || '' : '';
  const storedELKey      = !isProd ? localStorage.getItem('elevenlabs_key') || '' : '';
  // Prefer .env value; only fall back to localStorage if .env value is absent (undefined), not if it's intentionally empty ('')
  const envOr = (envVal, stored) => (envVal !== undefined && envVal !== '' ? envVal : stored);
  const [apiKey,        setApiKey]        = useState(isProd ? '' : envOr(import.meta.env.VITE_SARVAM_API_KEY,     storedKey));
  const [openaiKey,     setOpenaiKey]     = useState(isProd ? '' : envOr(import.meta.env.VITE_OPENAI_API_KEY,     storedOAIKey));
  const [groqKey,       setGroqKey]       = useState(isProd ? '' : envOr(import.meta.env.VITE_GROQ_API_KEY,       storedGroqKey));
  const [elevenLabsKey, setElevenLabsKey] = useState(isProd ? '' : envOr(import.meta.env.VITE_ELEVENLABS_API_KEY, storedELKey));
  const [showSetup, setShowSetup] = useState(!isProd && !apiKey);

  const fixLang = (v) => (v === 'od-IN' ? 'or-IN' : v); // migrate old Odia code
  const [langA, setLangA] = useState(() => fixLang(localStorage.getItem('vs_langA')) || 'hi-IN');
  const [langB, setLangB] = useState(() => fixLang(localStorage.getItem('vs_langB')) || 'te-IN');
  const [voiceA, setVoiceA] = useState(() => localStorage.getItem('vs_voiceA') || 'male');
  const [voiceB, setVoiceB] = useState(() => localStorage.getItem('vs_voiceB') || 'female');
  const [langTypeA, setLangTypeA] = useState(() => localStorage.getItem('vs_ltypeA') || 'indian');
  const [langTypeB, setLangTypeB] = useState(() => localStorage.getItem('vs_ltypeB') || 'indian');

  useEffect(() => { localStorage.setItem('vs_langA', langA); }, [langA]);
  useEffect(() => { localStorage.setItem('vs_langB', langB); }, [langB]);
  useEffect(() => { localStorage.setItem('vs_voiceA', voiceA); }, [voiceA]);
  useEffect(() => { localStorage.setItem('vs_voiceB', voiceB); }, [voiceB]);
  useEffect(() => { localStorage.setItem('vs_ltypeA', langTypeA); }, [langTypeA]);
  useEffect(() => { localStorage.setItem('vs_ltypeB', langTypeB); }, [langTypeB]);

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
  const streamingSTTRef = useRef(null);
  const silenceDetectorRef = useRef(null); // { interval, audioCtx }
  const stopRecordingRef = useRef(null);   // always-current ref for use inside callbacks
  const startRecordingRef = useRef(null);  // always-current ref for auto-restart
  const autoConvRef = useRef(false);       // mirrors autoConversation state for closure safety

  // Key used for WebSocket streaming — must be client-side (visible in devtools)
  const streamKey = import.meta.env.VITE_SARVAM_API_KEY || apiKey;

  const [partialTranscript, setPartialTranscript] = useState('');
  const [autoConversation, setAutoConversation] = useState(false);
  const peerRef = useRef(null);
  const connRef = useRef(null);
  const partnerHandlerRef = useRef(null);

  // Remote (two-phone) mode state
  const [remoteActive, setRemoteActive] = useState(false);
  const [peerState, setPeerState] = useState('idle'); // 'idle' | 'hosting' | 'joining' | 'connected' | 'error'
  const [roomCode, setRoomCode] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');
  const [partnerLang, setPartnerLang] = useState('');
  const [remoteError, setRemoteError] = useState('');
  const [remoteModal, setRemoteModal] = useState(null); // null | 'choose' | 'host' | 'join'

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

  const handleSaveKey = (sarvamKey, oaiKey, gKey, elKey) => {
    setApiKey(sarvamKey);
    setOpenaiKey(oaiKey);
    setGroqKey(gKey);
    setElevenLabsKey(elKey);
    try { localStorage.setItem('sarvam_key',     sarvamKey); } catch {}
    try { localStorage.setItem('openai_key',     oaiKey);    } catch {}
    try { localStorage.setItem('groq_key',       gKey);      } catch {}
    try { localStorage.setItem('elevenlabs_key', elKey);     } catch {}
    setShowSetup(false);
  };

  // Defensive: if Groq is available, never use OpenAI — wipe any stale key from state + localStorage
  useEffect(() => {
    if (groqKey && openaiKey) {
      setOpenaiKey('');
      try { localStorage.removeItem('openai_key'); } catch {}
    }
  }, [groqKey, openaiKey]);

  // Keep always-current refs so setTimeout/setInterval callbacks see fresh functions
  useEffect(() => { stopRecordingRef.current = stopRecording; });
  useEffect(() => { startRecordingRef.current = startRecording; });

  const clearSilenceDetector = useCallback(() => {
    if (silenceDetectorRef.current) {
      clearInterval(silenceDetectorRef.current.interval);
      silenceDetectorRef.current.audioCtx?.close().catch(() => {});
      silenceDetectorRef.current = null;
    }
  }, []);

  // Amplitude-based VAD: fires stopRecording after SILENCE_MS of quiet following speech
  const startSilenceDetection = useCallback((speaker, stream) => {
    clearSilenceDetector();
    const SILENCE_THRESHOLD = 10; // RMS on 0–128 scale
    const SILENCE_MS = 1500;
    const MIN_SPEECH_MS = 400;   // ignore silence until this much speech recorded
    const TICK = 100;

    const audioCtx = new AudioContext();
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    let speechMs = 0;
    let silenceMs = 0;

    const interval = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((s, v) => s + (v - 128) ** 2, 0) / data.length);

      if (rms >= SILENCE_THRESHOLD) {
        speechMs += TICK;
        silenceMs = 0;
      } else {
        silenceMs += TICK;
        if (speechMs >= MIN_SPEECH_MS && silenceMs >= SILENCE_MS) {
          clearInterval(interval);
          audioCtx.close().catch(() => {});
          silenceDetectorRef.current = null;
          stopRecordingRef.current?.(speaker);
        }
      }
    }, TICK);

    silenceDetectorRef.current = { interval, audioCtx };
  }, [clearSilenceDetector]);

  // Two-phone: start continuous hands-free conversation
  const startAutoConversation = useCallback(() => {
    unlockAudio(); // must be in user gesture so iOS AudioContext is ready for partner's TTS
    setAutoConversation(true);
    autoConvRef.current = true;
    startRecordingRef.current?.('a');
  }, []);

  const stopAutoConversation = useCallback(() => {
    setAutoConversation(false);
    autoConvRef.current = false;
    clearSilenceDetector();
    // stopRecording will no-op if not currently recording
    stopRecordingRef.current?.('a');
  }, [clearSilenceDetector]);

  const startRecording = useCallback((speaker) => {
    if (processing || recording) return;
    setError('');

    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone not supported on this browser. Try Safari 14.3+ or Chrome.');
      return;
    }

    unlockAudio();
    const warmBase = import.meta.env.DEV ? '/sarvam/speech-to-text' : '/api/speech-to-text';
    fetch(warmBase, { method: 'HEAD' }).catch(() => {});

    const setupStream = (stream) => {
      streamRef.current = stream;
      const mimeType = ['audio/mp4', 'audio/webm', ''].find(
        (t) => t === '' || MediaRecorder.isTypeSupported(t)
      );
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.start(100);
      mediaRecRef.current = recorder;

      // Streaming STT (Indian languages only)
      const sourceLang = remoteActive ? langA : (speaker === 'a' ? langA : langB);
      const canStream = supportsStreamingSTT() && isIndianLang(sourceLang) && streamKey;
      if (canStream) {
        const sttMode = sourceLang === 'en-IN' ? 'transcribe' : 'translate';
        const streamer = new SarvamStreamingSTT({
          apiKey: streamKey,
          languageCode: sourceLang,
          mode: sttMode,
          onPartial: (text) => setPartialTranscript(text),
        });
        streamer.start(stream).catch(() => { streamingSTTRef.current = null; });
        streamingSTTRef.current = streamer;
      }

      // Silence detection only in Go Live (hands-free) mode
      if (autoConvRef.current) startSilenceDetection(speaker, stream);

      setRecording(speaker);
    };

    // In Go Live mode reuse the existing open stream — avoids calling getUserMedia
    // from a setTimeout (which iOS Safari may block after first permission grant)
    const liveStream = streamRef.current;
    if (autoConvRef.current && liveStream?.active) {
      setupStream(liveStream);
      return;
    }

    navigator.mediaDevices.getUserMedia({ audio: true }).then(setupStream).catch((err) => {
      if (err.name === 'NotAllowedError') {
        setError('Microphone permission denied. On iPhone: Settings → Privacy → Microphone → enable Safari.');
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found on this device.');
      } else {
        setError(`Microphone error: ${err.name} — ${err.message}`);
      }
    });
  }, [processing, recording, remoteActive, langA, langB, streamKey, startSilenceDetection]);

  // ── Remote mode: incoming message from partner (English pivot → local TTS) ──
  const handlePartnerMessage = useCallback(async (msg) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'hello') {
      setPartnerLang(msg.lang || '');
      return;
    }
    if (msg.type !== 'english' || !msg.text) return;

    const messageId = Date.now();
    const srcLang = getLang(msg.sourceLang || 'en-IN');
    const tgtLang = getLang(langA);
    const sourceLabel = `Partner · ${srcLang.native}`;
    const targetLabel = `${tgtLang.native} (${tgtLang.name})`;

    const needsIntlA = !isIndianLang(langA);
    const effectiveGroqKeyP = groqKey || import.meta.env.VITE_GROQ_API_KEY || '';
    const useGroqA   = needsIntlA && !!effectiveGroqKeyP;
    const useOpenAI  = needsIntlA && !useGroqA && !!openaiKey;
    if (needsIntlA) console.log('[pipeline] partner intl →', useGroqA ? 'Groq' : useOpenAI ? 'OpenAI' : 'none');
    const onStep = (id, m) => { setStepId(id); setStepMsg(m); };
    const onText = (pivotText, translatedText) => {
      setMessages((prev) => [
        ...prev,
        {
          id: messageId,
          speaker: 'b',
          sourceLabel,
          targetLabel,
          pivotText,
          translatedText,
          sourceLang: msg.sourceLang || 'en-IN',
          targetLang: langA,
        },
      ]);
      setProcessing(false);
      setStepId('');
      setStepMsg('');
    };

    try {
      setProcessing(true);
      const result = useGroqA
        ? await groqEnglishToSpeech({
            pivotText: msg.text,
            targetLang: langA,
            targetLangName: tgtLang.name,
            voiceGender: voiceA,
            groqKey: effectiveGroqKeyP,
            openaiKey,
            onStep,
            onText,
          })
        : useOpenAI
          ? await openaiEnglishToSpeech({
              pivotText: msg.text,
              targetLang: langA,
              targetLangName: tgtLang.name,
              voiceGender: voiceA,
              openaiKey,
              onStep,
              onText,
            })
          : await englishToSpeech({
              pivotText: msg.text,
              targetLang: langA,
              voice: VOICES[voiceA],
              apiKey,
              onStep,
              onText,
              // In hands-free Go Live, use streaming Bulbul for ~200-500ms
              // first-audio latency vs ~1-3s on the batch endpoint.
              streamTTS: autoConvRef.current,
            });
      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, audioB64: result.audioB64 } : m));

      // After partner's audio finishes playing, restart listening in hands-free mode
      result.audioPromise?.then(() => {
        if (autoConvRef.current) {
          setTimeout(() => startRecordingRef.current?.('a'), 350);
        }
      });
    } catch (err) {
      setError(err.message);
      setProcessing(false);
      setStepId('');
      setStepMsg('');
      if (autoConvRef.current) {
        setTimeout(() => startRecordingRef.current?.('a'), 800);
      }
    }
  }, [langA, voiceA, apiKey, openaiKey, groqKey, elevenLabsKey]);

  // Keep latest handler in a ref so PeerJS callbacks always see fresh state
  useEffect(() => { partnerHandlerRef.current = handlePartnerMessage; }, [handlePartnerMessage]);

  const attachConnection = useCallback((conn) => {
    connRef.current = conn;
    conn.on('open', () => {
      unlockAudio(); // pre-warm AudioContext so incoming TTS plays without user gesture
      setPeerState('connected');
      setRemoteModal(null);
      try { conn.send({ type: 'hello', lang: langA, voice: voiceA }); } catch {}
    });
    conn.on('data', (data) => partnerHandlerRef.current?.(data));
    conn.on('close', () => {
      setPeerState('idle');
      setRemoteError('Partner disconnected.');
      connRef.current = null;
    });
    conn.on('error', (err) => {
      setRemoteError(`Connection error: ${err.type || err.message || 'unknown'}`);
    });
  }, [langA, voiceA]);

  const createRoom = useCallback(() => {
    unlockAudio();
    setRemoteError('');
    const code = generateRoomCode();
    setRoomCode(code);
    setPeerState('hosting');
    setRemoteModal('host');
    try { peerRef.current?.destroy(); } catch {}
    const peer = new Peer(hostPeerId(code), { debug: 1, config: { iceServers: ICE_SERVERS } });
    peerRef.current = peer;
    peer.on('connection', attachConnection);
    peer.on('error', (err) => {
      const type = err.type || '';
      if (type === 'unavailable-id') {
        setRemoteError('Room code clash — try creating again.');
      } else {
        setRemoteError(`Peer error: ${type || err.message || 'unknown'}`);
      }
      setPeerState('error');
    });
  }, [attachConnection]);

  const joinRoom = useCallback((rawCode) => {
    const code = (rawCode || '').trim().toUpperCase();
    if (code.length !== 4) {
      setRemoteError('Enter the 4-letter room code.');
      return;
    }
    unlockAudio();
    setRemoteError('');
    setRoomCode(code);
    setPeerState('joining');
    try { peerRef.current?.destroy(); } catch {}
    const peer = new Peer(undefined, { debug: 1, config: { iceServers: ICE_SERVERS } });
    peerRef.current = peer;
    peer.on('open', () => {
      const conn = peer.connect(hostPeerId(code), { reliable: true });
      attachConnection(conn);
    });
    peer.on('error', (err) => {
      const type = err.type || '';
      if (type === 'peer-unavailable') {
        setRemoteError(`Room ${code} not found. Check the code with your partner.`);
      } else {
        setRemoteError(`Peer error: ${type || err.message || 'unknown'}`);
      }
      setPeerState('error');
    });
  }, [attachConnection]);

  const disconnectRemote = useCallback(() => {
    try { connRef.current?.close(); } catch {}
    try { peerRef.current?.destroy(); } catch {}
    connRef.current = null;
    peerRef.current = null;
    setPeerState('idle');
    setRoomCode('');
    setJoinCodeInput('');
    setPartnerLang('');
    setRemoteError('');
    setRemoteModal(null);
    setRemoteActive(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => () => {
    try { connRef.current?.close(); } catch {}
    try { peerRef.current?.destroy(); } catch {}
  }, []);

  // Notify partner when my language/voice preferences change after connecting
  useEffect(() => {
    if (peerState === 'connected' && connRef.current?.open) {
      try { connRef.current.send({ type: 'hello', lang: langA, voice: voiceA }); } catch {}
    }
  }, [langA, voiceA, peerState]);

  const stopRecording = useCallback(async (speaker) => {
    if (!mediaRecRef.current || recording !== speaker) return;

    clearSilenceDetector();
    setRecording(null);
    setProcessing(true);
    setPartialTranscript('');

    // Stop MediaRecorder (fallback blob) and streaming STT in parallel
    const [, streamingTranscript] = await Promise.all([
      new Promise((resolve) => {
        mediaRecRef.current.onstop = resolve;
        mediaRecRef.current.stop();
      }),
      streamingSTTRef.current
        ? streamingSTTRef.current.stop().catch(() => '')
        : Promise.resolve(''),
    ]);
    streamingSTTRef.current = null;
    // In Go Live mode keep the stream alive so iOS can reuse it without a getUserMedia call from setTimeout
    if (!autoConvRef.current) {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }

    const rawMime = mediaRecRef.current?.mimeType || 'audio/webm';
    const mimeType = rawMime.split(';')[0];
    const audioBlob = new Blob(chunksRef.current, { type: mimeType });
    if (audioBlob.size < 1000) {
      setError('Recording too short. Hold the button while speaking.');
      setProcessing(false);
      return;
    }

    // streamingTranscript is already the English pivot (mode=translate) or
    // verbatim text (mode=transcribe). Non-empty means we can skip STT.
    const pivotFromStream = streamingTranscript?.trim() || null;

    // ── Remote (two-phone) branch ────────────────────────────────────────────
    if (remoteActive) {
      const srcLang = getLang(langA);
      const messageId = Date.now();
      const sourceLabel = `${srcLang.native} (${srcLang.name})`;
      const effectiveGroqKeyR = groqKey || import.meta.env.VITE_GROQ_API_KEY || '';
      const useGroqRemote   = !isIndianLang(langA) && !!effectiveGroqKeyR;
      const useOpenAIRemote = !isIndianLang(langA) && !useGroqRemote && !!openaiKey;
      if (!isIndianLang(langA)) console.log('[pipeline] remote intl →', useGroqRemote ? 'Groq' : useOpenAIRemote ? 'OpenAI' : 'none');
      const onStepR = (id, m) => { setStepId(id); setStepMsg(m); };
      try {
        const pivotText = pivotFromStream
          ? (onStepR('stt', ''), pivotFromStream)
          : useGroqRemote || useOpenAIRemote
            ? useGroqRemote
              ? await groqSpeechToEnglishPipeline({ audioBlob, groqKey: effectiveGroqKeyR, sourceLang: langA, onStep: onStepR })
              : await openaiSpeechToEnglishPipeline({ audioBlob, openaiKey, onStep: onStepR })
            : await speechToEnglish({ audioBlob, sourceLang: langA, apiKey, onStep: onStepR });
        if (connRef.current?.open) {
          connRef.current.send({ type: 'english', text: pivotText, sourceLang: langA, ts: Date.now() });
        } else {
          setError('Not connected to partner. Please reconnect.');
        }
        setMessages((prev) => [
          ...prev,
          { id: messageId, speaker: 'a', sourceLabel, targetLabel: 'Sent to partner', pivotText, translatedText: pivotText, sourceLang: langA, targetLang: 'en-IN', remote: true },
        ]);
      } catch (err) {
        setError(err.message);
      }
      setProcessing(false);
      setStepId('');
      setStepMsg('');
      // Auto-restart for hands-free mode — sender has no audio to wait for,
      // so restart immediately after sending pivot text to partner
      if (autoConvRef.current && peerState === 'connected') {
        setTimeout(() => startRecordingRef.current?.('a'), 350);
      }
      return;
    }

    // ── Solo (single-device) branch ──────────────────────────────────────────
    const sourceLang = speaker === 'a' ? langA : langB;
    const targetLang = speaker === 'a' ? langB : langA;
    // Voice follows the LISTENER: when A speaks, B is hearing the output, so use B's voice preference
    const listenerVoice = speaker === 'a' ? voiceB : voiceA;
    const voice = VOICES[listenerVoice]; // Sarvam voice name

    const srcLang = getLang(sourceLang);
    const tgtLang = getLang(targetLang);
    const messageId = Date.now();
    const sourceLabel = `${srcLang.native} (${srcLang.name})`;
    const targetLabel = `${tgtLang.native} (${tgtLang.name})`;

    const needsIntl = !isIndianLang(sourceLang) || !isIndianLang(targetLang);
    // Prefer Groq for intl when any Groq key is present (state OR env). Only fall back
    // to OpenAI if no Groq key exists anywhere — prevents stale OpenAI key from taking over.
    const effectiveGroqKey = groqKey || import.meta.env.VITE_GROQ_API_KEY || '';
    const useGroq   = needsIntl && !!effectiveGroqKey;
    const useOpenAI = needsIntl && !useGroq && !!openaiKey;
    if (needsIntl) console.log('[pipeline] solo intl →', useGroq ? 'Groq' : useOpenAI ? 'OpenAI' : 'none', { groqKey: !!effectiveGroqKey, openaiKey: !!openaiKey });

    const onStep = (id, msg) => { setStepId(id); setStepMsg(msg); };
    const onText = (pivotText, translatedText) => {
      setMessages((prev) => [
        ...prev,
        { id: messageId, speaker, sourceLabel, targetLabel, pivotText, translatedText, sourceLang, targetLang },
      ]);
      setProcessing(false);
      setStepId('');
      setStepMsg('');
    };

    try {
      let result;

      if (pivotFromStream && !needsIntl) {
        // Fast path: streaming STT gave us English pivot — skip STT call
        onStep('stt', '');
        result = await englishToSpeech({
          pivotText: pivotFromStream,
          targetLang,
          voice,
          apiKey,
          onStep,
          onText,
        });
      } else if (useGroq) {
        result = await runGroqPipeline({
          audioBlob,
          sourceLang,
          targetLang,
          targetLangName: tgtLang.name,
          voiceGender: listenerVoice,
          groqKey: effectiveGroqKey,
          openaiKey,
          onStep,
          onText,
        });
      } else if (useOpenAI) {
        result = await runOpenAIPipeline({
          audioBlob,
          sourceLang,
          sourceLangName: srcLang.name,
          targetLang,
          targetLangName: tgtLang.name,
          voiceGender: listenerVoice,
          openaiKey,
          onStep,
          onText,
        });
      } else {
        result = await runTranslatePipeline({
          audioBlob,
          sourceLang,
          targetLang,
          voice,
          apiKey,
          onStep,
          onText,
        });
      }

      setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, audioB64: result.audioB64 } : m));

      // Auto-restart for two-phone live conversation mode
      result.audioPromise?.then(() => {
        if (autoConvRef.current && peerState === 'connected') {
          setTimeout(() => startRecordingRef.current?.('a'), 350);
        }
      });
    } catch (err) {
      setError(err.message);
      setProcessing(false);
      setStepId('');
      setStepMsg('');
      // Even on error, keep live mode going
      if (autoConvRef.current && peerState === 'connected') {
        setTimeout(() => startRecordingRef.current?.('a'), 800);
      }
    }
  }, [recording, remoteActive, langA, langB, voiceA, voiceB, apiKey, openaiKey, groqKey, elevenLabsKey, streamKey, clearSilenceDetector, peerState]);

  if (showSetup) {
    return <SetupScreen onSave={handleSaveKey} existingKey={apiKey} existingOaiKey={openaiKey} existingGroqKey={groqKey} existingELKey={elevenLabsKey} />;
  }

  const partnerLangInfo = getLang(partnerLang || 'hi-IN');

  return (
    <div style={s.root}>
      {/* ── Top Bar ── */}
      <header style={s.topBar}>
        <div style={s.logoWrap}>
          <span style={s.logoIcon}>𝕍</span>
          <div>
            <div style={s.logoName}>VaakSetu</div>
            <div style={s.logoSub}>{remoteActive ? 'Remote Mode' : 'Voice Translator'}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {remoteActive ? (
            <>
              {peerState === 'connected' && (
                <div style={s.connectedBadge}>
                  <span style={{ color: '#4ade80', fontSize: '0.55rem' }}>●</span> Connected
                </div>
              )}
              <button style={s.remoteBtn} onClick={disconnectRemote}>Disconnect</button>
            </>
          ) : (
            <button
              style={s.remoteBtn}
              onClick={() => { setRemoteActive(true); setRemoteModal('choose'); }}
            >
              📱 Two Phones
            </button>
          )}
          {!isProd && <button style={s.gearBtn} title="Settings" onClick={() => setShowSetup(true)}>⚙</button>}
        </div>
      </header>

      {/* ── Remote pairing modal ── */}
      {remoteModal && (
        <RemoteModal
          mode={remoteModal}
          peerState={peerState}
          roomCode={roomCode}
          joinCodeInput={joinCodeInput}
          remoteError={remoteError}
          onSetMode={setRemoteModal}
          onJoinInputChange={(v) => { setJoinCodeInput(v.toUpperCase()); setRemoteError(''); }}
          onCreateRoom={createRoom}
          onJoinRoom={() => joinRoom(joinCodeInput)}
          onCancel={() => { disconnectRemote(); }}
        />
      )}

      {/* ── Language + Voice selectors ── */}
      <div style={s.selectorRow}>
        {remoteActive ? (
          <>
            <PersonSelector
              color={COLORS.amber}
              label="My Language"
              lang={langA}
              voice={voiceA}
              langType={langTypeA}
              onLangChange={(v) => { setLangA(v); setError(''); }}
              onVoiceChange={setVoiceA}
              onLangTypeChange={setLangTypeA}
            />
            <div style={s.selectorDivider}>↔</div>
            <div style={s.personCol}>
              <div style={{ ...s.personLabel, color: COLORS.teal }}>Partner's Language</div>
              <div style={{ ...s.langSelect, borderColor: COLORS.teal, color: COLORS.teal, display: 'flex', alignItems: 'center' }}>
                {partnerLang
                  ? `${partnerLangInfo.name} — ${partnerLangInfo.native}`
                  : <span style={{ color: COLORS.muted }}>Waiting…</span>}
              </div>
              <div style={{ fontSize: '0.68rem', color: COLORS.muted, marginTop: 2 }}>Set on their phone</div>
            </div>
          </>
        ) : (
          <>
            <PersonSelector
              color={COLORS.amber}
              label="Person A"
              lang={langA}
              voice={voiceA}
              langType={langTypeA}
              onLangChange={(v) => { setLangA(v); setError(''); }}
              onVoiceChange={setVoiceA}
              onLangTypeChange={setLangTypeA}
            />
            <div style={s.selectorDivider}>↔</div>
            <PersonSelector
              color={COLORS.teal}
              label="Person B"
              lang={langB}
              voice={voiceB}
              langType={langTypeB}
              onLangChange={(v) => { setLangB(v); setError(''); }}
              onVoiceChange={setVoiceB}
              onLangTypeChange={setLangTypeB}
            />
          </>
        )}
      </div>

      {/* ── Conversation ── */}
      <div style={s.feed}>
        {messages.length === 0 && !processing && (
          <div style={s.empty}>
            <div style={s.emptyOrb}>{remoteActive ? '📱' : '🗣️'}</div>
            <p style={s.emptyTitle}>{remoteActive ? 'Ready — say something' : 'Ready to translate'}</p>
            <p style={s.emptySub}>
              {remoteActive
                ? autoConversation
                  ? 'Go ahead — speak when ready. Silence will trigger translation automatically.'
                  : peerState === 'connected'
                    ? 'Tap the button to speak, or tap "Go Live" for hands-free mode.'
                    : 'Waiting to connect to your partner…'
                : <>
                    Hold <span style={{ color: COLORS.amber }}>Person A</span> or{' '}
                    <span style={{ color: COLORS.teal }}>Person B</span> button and speak.
                    <br />Release to hear the translation.
                  </>}
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <MessageBubble key={msg.id} msg={msg} />
        ))}

        {/* Live partial transcript while speaking */}
        {recording && partialTranscript && (
          <div style={s.partialRow}>
            <span style={s.partialDot}>●</span>
            <span style={s.partialText}>{partialTranscript}</span>
          </div>
        )}

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
        {remoteActive ? (
          autoConversation ? (
            <LiveModeIndicator onLeave={stopAutoConversation} isRecording={!!recording} processing={processing} />
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '20px 12px' }}>
              <SpeakerButton
                label={getLang(langA).native}
                sub={getLang(langA).name}
                color={COLORS.amber}
                isRecording={recording === 'a'}
                disabled={processing || peerState !== 'connected'}
                onStart={() => startRecording('a')}
                onStop={() => stopRecording('a')}
              />
              {peerState === 'connected' && (
                <button style={s.goLiveBtn} onClick={startAutoConversation}>
                  🎙 Go Live — hands-free
                </button>
              )}
            </div>
          )
        ) : (
          <>
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
          </>
        )}
      </div>
    </div>
  );
}

// ─── Speaker Button ──────────────────────────────────────────────────────────
// ─── Person Selector (language + voice) ──────────────────────────────────────
function PersonSelector({ color, label, lang, voice, langType, onLangChange, onVoiceChange, onLangTypeChange }) {
  const langList = langType === 'intl' ? PICKER_INTL_LANGUAGES : PICKER_LANGUAGES;
  const currentLangInList = langList.some((l) => l.code === lang);

  // When switching type, default to first language of that type
  const handleTypeChange = (type) => {
    onLangTypeChange(type);
    if (type === 'intl') onLangChange(INTL_LANGUAGES[0].code);
    else onLangChange('hi-IN');
  };

  return (
    <div style={s.personCol}>
      <div style={{ ...s.personLabel, color }}>{label}</div>

      {/* Indian / International toggle */}
      <div style={{ display: 'flex', gap: 3, marginBottom: 4 }}>
        {[['indian', '🇮🇳 Indian'], ['intl', '🌍 Intl']].map(([type, lbl]) => (
          <button
            key={type}
            style={{
              ...s.typeToggleBtn,
              background: langType === type ? color : 'transparent',
              color: langType === type ? '#0C0B1A' : color,
              borderColor: color,
            }}
            onClick={() => handleTypeChange(type)}
          >
            {lbl}
          </button>
        ))}
      </div>

      <select
        style={{ ...s.langSelect, borderColor: color, color }}
        value={currentLangInList ? lang : langList[0].code}
        onChange={(e) => onLangChange(e.target.value)}
      >
        {langList.map((l) => (
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

// ─── Live Mode Controls (two-phone hands-free) ───────────────────────────────
function LiveModeIndicator({ onLeave, isRecording, processing }) {
  return (
    <div style={s.liveModeWrap}>
      <div style={s.liveStatusRow}>
        <span style={{ ...s.liveDot, color: isRecording ? COLORS.amber : processing ? COLORS.teal : '#4ade80' }}>●</span>
        <span style={s.liveLabel}>
          {isRecording ? 'Listening…' : processing ? 'Translating…' : 'Ready'}
        </span>
      </div>
      <p style={s.liveHint}>Speak naturally — silence triggers translation automatically</p>
      <button style={s.leaveBtn} onClick={onLeave}>Leave Conversation</button>
    </div>
  );
}

// ─── Remote Mode Pairing Modal ───────────────────────────────────────────────
function RemoteModal({ mode, peerState, roomCode, joinCodeInput, remoteError, onSetMode, onJoinInputChange, onCreateRoom, onJoinRoom, onCancel }) {
  return (
    <div style={s.modalOverlay}>
      <div style={s.modalCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={s.modalTitle}>Two-Phone Mode</h2>
          <button style={s.gearBtn} onClick={onCancel}>✕</button>
        </div>

        {mode === 'choose' && (
          <>
            <p style={s.modalSub}>Each person uses their own phone. Both hear translations in their own language.</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button style={{ ...s.modalActionBtn, borderColor: COLORS.amber, color: COLORS.amber }} onClick={onCreateRoom}>
                Create Room
              </button>
              <button style={{ ...s.modalActionBtn, borderColor: COLORS.teal, color: COLORS.teal }} onClick={() => onSetMode('join')}>
                Join Room
              </button>
            </div>
          </>
        )}

        {mode === 'host' && (
          <>
            {peerState === 'hosting' && (
              <>
                <p style={s.modalSub}>Share this code with your partner:</p>
                <div style={s.roomCode}>{roomCode}</div>
                <p style={{ ...s.modalSub, marginTop: 12 }}>Waiting for partner to join…</p>
                <div style={s.spinnerRow}><span style={s.spinner}>⏳</span></div>
              </>
            )}
            {peerState === 'connected' && (
              <p style={{ ...s.modalSub, color: '#4ade80' }}>Partner connected! Close this to start speaking.</p>
            )}
            {peerState === 'error' && (
              <>
                <p style={{ ...s.modalSub, color: '#FF7A7A' }}>{remoteError || 'Connection failed.'}</p>
                <button style={{ ...s.modalActionBtn, borderColor: COLORS.amber, color: COLORS.amber, marginTop: 12 }} onClick={onCreateRoom}>Try Again</button>
              </>
            )}
          </>
        )}

        {mode === 'join' && (
          <>
            <p style={s.modalSub}>Enter the 4-letter code from your partner's phone:</p>
            <input
              style={s.codeInput}
              maxLength={4}
              placeholder="ABCD"
              value={joinCodeInput}
              onChange={(e) => onJoinInputChange(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onJoinRoom()}
              autoFocus
              autoCapitalize="characters"
            />
            {remoteError && <p style={{ color: '#FF7A7A', fontSize: '0.8rem', marginTop: 6 }}>{remoteError}</p>}
            {peerState === 'joining' && <p style={{ ...s.modalSub, marginTop: 10 }}>Connecting…</p>}
            {peerState === 'connected' && <p style={{ ...s.modalSub, color: '#4ade80', marginTop: 10 }}>Connected! Close this to start speaking.</p>}
            {(peerState === 'idle' || peerState === 'error') && (
              <button
                style={{ ...s.modalActionBtn, borderColor: COLORS.teal, color: COLORS.teal, marginTop: 14, width: '100%' }}
                onClick={onJoinRoom}
                disabled={joinCodeInput.length < 4}
              >
                Join
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Setup / API Key Screen ──────────────────────────────────────────────────
function SetupScreen({ onSave, existingKey, existingOaiKey, existingGroqKey, existingELKey }) {
  const [key,    setKey]    = useState(existingKey    || '');
  const [oaiKey, setOaiKey] = useState(existingOaiKey || '');
  const [gKey,   setGKey]   = useState(existingGroqKey || '');
  const [elKey,  setElKey]  = useState(existingELKey  || '');
  const valid = key.trim().length > 20;

  const save = () => valid && onSave(key.trim(), oaiKey.trim(), gKey.trim(), elKey.trim());

  return (
    <div style={s.setupRoot}>
      <div style={s.setupCard}>
        <div style={s.setupLogo}>𝕍</div>
        <h1 style={s.setupTitle}>VaakSetu</h1>
        <p style={s.setupSub}>Bidirectional voice translator for Indian &amp; international languages</p>

        <div style={s.setupDivider} />

        {/* Sarvam — required */}
        <label style={s.setupLabel}>Sarvam AI API Key <span style={{ color: COLORS.amber }}>*required</span></label>
        <input style={s.setupInput} type="password" placeholder="sk_…" value={key} onChange={(e) => setKey(e.target.value)} autoFocus />
        <p style={s.setupHint}>
          <a href="https://dashboard.sarvam.ai" target="_blank" rel="noreferrer" style={{ color: COLORS.amber }}>dashboard.sarvam.ai</a>
          {' '}— Indian languages (STT + translate + TTS)
        </p>

        {/* Groq — recommended for intl */}
        <label style={{ ...s.setupLabel, marginTop: 10 }}>Groq API Key <span style={{ color: COLORS.teal }}>recommended for international</span></label>
        <input style={s.setupInput} type="password" placeholder="gsk_…" value={gKey} onChange={(e) => setGKey(e.target.value)} />
        <p style={s.setupHint}>
          <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer" style={{ color: COLORS.teal }}>console.groq.com</a>
          {' '}— Whisper STT + Llama translate. Free tier available.
        </p>

        {/* ElevenLabs — recommended for intl TTS */}
        <label style={{ ...s.setupLabel, marginTop: 10 }}>ElevenLabs API Key <span style={{ color: COLORS.muted }}>optional — better voice quality</span></label>
        <input style={s.setupInput} type="password" placeholder="sk_…" value={elKey} onChange={(e) => setElKey(e.target.value)} />
        <p style={s.setupHint}>
          <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noreferrer" style={{ color: COLORS.teal }}>elevenlabs.io</a>
          {' '}— Natural TTS in 32 languages. Free tier: 10k chars/month.
        </p>

        {/* OpenAI — fallback */}
        <label style={{ ...s.setupLabel, marginTop: 10 }}>OpenAI API Key <span style={{ color: COLORS.muted }}>fallback if no Groq/ElevenLabs</span></label>
        <input
          style={s.setupInput}
          type="password"
          placeholder="sk-proj-…"
          value={oaiKey}
          onChange={(e) => setOaiKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <p style={s.setupHint}>
          <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer" style={{ color: COLORS.muted }}>platform.openai.com</a>
        </p>

        <button
          style={{ ...s.setupBtn, opacity: valid ? 1 : 0.4, cursor: valid ? 'pointer' : 'default' }}
          onClick={save}
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
  typeToggleBtn: {
    flex: 1,
    border: '1px solid',
    borderRadius: 6,
    padding: '3px 5px',
    fontSize: '0.65rem',
    fontFamily: "'DM Sans', sans-serif",
    cursor: 'pointer',
    fontWeight: 700,
    transition: 'all 0.15s',
    whiteSpace: 'nowrap',
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

  // Live partial transcript (streaming STT)
  partialRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '10px 14px',
    background: 'transparent',
    border: `1px dashed ${COLORS.border}`,
    borderRadius: 12,
    alignSelf: 'center',
    maxWidth: '82%',
    animation: 'fade-up 0.15s ease forwards',
  },
  partialDot: {
    fontSize: '0.5rem',
    color: COLORS.amber,
    marginTop: 4,
    flexShrink: 0,
    animation: 'pulse-ring 1s ease-in-out infinite',
  },
  partialText: {
    fontSize: '0.9rem',
    color: COLORS.muted,
    fontStyle: 'italic',
    lineHeight: 1.5,
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

  // Go Live button
  goLiveBtn: {
    background: `${COLORS.amber}18`,
    border: `1.5px solid ${COLORS.amber}`,
    borderRadius: 24,
    color: COLORS.amber,
    fontSize: '0.85rem',
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: 700,
    padding: '10px 24px',
    cursor: 'pointer',
    letterSpacing: '0.02em',
    transition: 'all 0.15s',
  },

  // Live mode (hands-free) indicator panel
  liveModeWrap: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: '24px 20px',
  },
  liveStatusRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  liveDot: {
    fontSize: '1rem',
    transition: 'color 0.3s ease',
  },
  liveLabel: {
    fontSize: '1.1rem',
    fontFamily: "'Crimson Pro', serif",
    color: COLORS.text,
    fontWeight: 600,
  },
  liveHint: {
    fontSize: '0.8rem',
    color: COLORS.muted,
    textAlign: 'center',
    maxWidth: 260,
    lineHeight: 1.5,
    margin: 0,
  },
  leaveBtn: {
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    color: COLORS.muted,
    fontSize: '0.8rem',
    fontFamily: "'DM Sans', sans-serif",
    padding: '8px 18px',
    cursor: 'pointer',
    marginTop: 4,
  },

  // Remote connect button
  remoteBtn: {
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    color: COLORS.muted,
    fontSize: '0.72rem',
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: 600,
    padding: '5px 10px',
    cursor: 'pointer',
    flexShrink: 0,
  },
  connectedBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: '0.68rem',
    color: COLORS.muted,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    padding: '4px 8px',
  },

  // Remote pairing modal
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(12,11,26,0.88)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: 20,
  },
  modalCard: {
    background: COLORS.surface,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 18,
    padding: '24px 22px',
    width: '100%',
    maxWidth: 340,
  },
  modalTitle: {
    fontFamily: "'Crimson Pro', serif",
    fontSize: '1.3rem',
    color: COLORS.text,
    margin: 0,
  },
  modalSub: {
    fontSize: '0.85rem',
    color: COLORS.muted,
    lineHeight: 1.55,
    margin: 0,
  },
  modalActionBtn: {
    flex: 1,
    background: 'transparent',
    border: '1.5px solid',
    borderRadius: 10,
    padding: '11px 14px',
    fontSize: '0.9rem',
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'opacity 0.15s',
  },
  roomCode: {
    fontFamily: 'monospace',
    fontSize: '2.6rem',
    letterSpacing: '0.25em',
    color: COLORS.amber,
    fontWeight: 700,
    textAlign: 'center',
    padding: '16px 0 8px',
  },
  spinnerRow: {
    display: 'flex',
    justifyContent: 'center',
    marginTop: 8,
  },
  spinner: { fontSize: '1.2rem' },
  codeInput: {
    display: 'block',
    width: '100%',
    textAlign: 'center',
    padding: '12px',
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 10,
    color: COLORS.amber,
    fontSize: '1.8rem',
    fontFamily: 'monospace',
    letterSpacing: '0.3em',
    fontWeight: 700,
    marginTop: 12,
    outline: 'none',
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
