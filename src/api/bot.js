// bot.js — client wrappers for the Meeting Bot control plane + relay socket.
// The relay base URLs are baked into the bundle so the client can WAKE the
// free-tier relay (cold start) BEFORE asking Recall to connect to it.
import { authedFetch } from '../lib/authed-fetch.js';

// One var for both: the WS URL is derived from the HTTP one (https→wss).
const RELAY_HTTP = import.meta.env.VITE_BOT_RELAY_HTTP_URL || '';
const RELAY_WS   = RELAY_HTTP.replace(/^http/, 'ws');

// Wake the relay from cold start. Polls /health with backoff until it responds
// or the budget runs out. Calls onProgress(elapsedSeconds) so the UI can show a
// counter instead of a frozen button. Resolves true on success, false on giveup.
export async function wakeRelay(onProgress, { budgetMs = 75000 } = {}) {
  if (!RELAY_HTTP) throw new Error('VITE_BOT_RELAY_HTTP_URL not configured');
  const start = Date.now();
  const delays = [0, 3000, 5000, 8000, 8000, 10000, 10000, 12000, 12000];
  let i = 0;
  while (Date.now() - start < budgetMs) {
    onProgress?.(Math.round((Date.now() - start) / 1000));
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(`${RELAY_HTTP}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) return true;
    } catch { /* server still booting */ }
    await new Promise((r) => setTimeout(r, delays[Math.min(i, delays.length - 1)]));
    i++;
  }
  return false;
}

export async function createBot({ agentLang, customerLang, agentVoice, customerVoice }) {
  const res = await authedFetch('/api/bot/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentLang, customerLang, agentVoice, customerVoice }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `create failed (${res.status})`);
  return res.json(); // { sessionId, roomName, customerUrl }
}

export async function stopBot({ sessionId }) {
  const res = await authedFetch('/api/bot/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  return res.ok;
}

// Open the agent's WebSocket to the relay. `handlers` = { onStatus, onTranscript,
// onAudio, onError, onClose }. Returns the WebSocket plus a sendUtterance helper.
export function connectAgentSocket(sessionId, handlers = {}) {
  if (!RELAY_WS) throw new Error('VITE_BOT_RELAY_WS_URL not configured');
  const ws = new WebSocket(`${RELAY_WS}/agent?sessionId=${encodeURIComponent(sessionId)}`);

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'status':     handlers.onStatus?.(msg.state, msg.detail); break;
      case 'transcript': handlers.onTranscript?.(msg); break;
      case 'audio':      handlers.onAudio?.(msg); break;
      case 'error':      handlers.onError?.(msg.message); break;
      case 'pong':       break;
      default: break;
    }
  };
  ws.onclose = () => handlers.onClose?.();
  ws.onerror = () => handlers.onError?.('Relay socket error');

  // Keep-alive ping (mirrors the server's reaper).
  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, 25000);
  ws.addEventListener('close', () => clearInterval(pingTimer));

  // Send a complete agent utterance (Blob → base64) to the relay.
  async function sendUtterance(blob) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const data = await blobToBase64(blob);
    ws.send(JSON.stringify({ type: 'agent-utterance', mime: blob.type || 'audio/webm', data }));
  }

  return { ws, sendUtterance };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
