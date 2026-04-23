// Service worker — orchestrates lifecycle and routes messages between
// popup / offscreen document / content-script widget.
//
// Because MV3 service workers cannot hold MediaStreams, all audio
// capture + pipeline work happens in the offscreen document.

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen/offscreen.html');
let activeTabId = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab + mic audio and play translated TTS back to the agent.',
  });
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

async function startSession(tabId) {
  const cfg = await chrome.storage.local.get([
    'agentLang','customerLang','agentVoice','customerVoice',
    'micDeviceId','sinkAgent','sinkCustomer','outputSinkId',
  ]);
  const agentLang     = cfg.agentLang    || 'en-IN';
  const customerLang  = cfg.customerLang || 'hi-IN';
  const agentVoice    = cfg.agentVoice   || 'male';
  const customerVoice = cfg.customerVoice|| 'female';
  // micDeviceId  = which input device VaakSetu captures from (avoid defaulting
  //                to a virtual cable that Windows may have flipped to system default).
  // sinkAgent    = where agent-speech translation plays (→ customer via Meet mic; usually VCC).
  // sinkCustomer = where customer-speech translation plays (→ agent's headphones).
  // Migrate the old single-sink preference onto sinkAgent.
  const micDeviceId  = cfg.micDeviceId  ?? 'default';
  const sinkAgent    = cfg.sinkAgent    ?? cfg.outputSinkId ?? 'default';
  const sinkCustomer = cfg.sinkCustomer ?? 'default';

  // getMediaStreamId must be called while a user-gesture context is alive.
  // Popup click → runtime.sendMessage → this handler — the gesture is still
  // valid because Chrome treats the messaging call as user-initiated.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await ensureOffscreen();

  // Give the offscreen doc a moment to bind its message listener on first boot.
  await new Promise((r) => setTimeout(r, 80));

  await chrome.runtime.sendMessage({
    to: 'offscreen',
    cmd: 'init',
    streamId, tabId,
    agentLang, customerLang, agentVoice, customerVoice,
    micDeviceId, sinkAgent, sinkCustomer,
  });

  activeTabId = tabId;
  await chrome.storage.local.set({ running: true, activeTabId: tabId });

  // Silence the Meet tab at the OS audio sink so the agent only hears the
  // translated output. `tabCapture` taps the audio pipeline upstream of the
  // mute, so our capture stream still receives the customer's voice for
  // analysis — this just stops Chrome from playing it to the speakers.
  try { await chrome.tabs.update(tabId, { muted: true }); } catch (e) {
    console.warn('[bg] could not mute tab', tabId, e?.message);
  }

  // Tell the widget in that tab to become visible.
  try {
    await chrome.tabs.sendMessage(tabId, { event: 'show', agentLang, customerLang });
  } catch (e) {
    // Widget may not be loaded on restricted pages (chrome://, Chrome Web Store).
    console.warn('[bg] widget not reachable on tab', tabId, e?.message);
  }
}

async function stopSession() {
  try { await chrome.runtime.sendMessage({ to: 'offscreen', cmd: 'stop' }); } catch {}
  await closeOffscreen();
  if (activeTabId) {
    try { await chrome.tabs.sendMessage(activeTabId, { event: 'hide' }); } catch {}
    // Restore the call tab's audio — the agent is no longer translating.
    try { await chrome.tabs.update(activeTabId, { muted: false }); } catch {}
  }
  await chrome.storage.local.set({ running: false, activeTabId: null });
  activeTabId = null;
}

// ─── Message router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg?.type === 'start') {
        await startSession(msg.tabId);
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'stop') {
        await stopSession();
        sendResponse({ ok: true });
        return;
      }

      // Widget → offscreen commands.
      if (msg?.type === 'recordCustomer' || msg?.type === 'recordAgent' || msg?.type === 'stopRecord') {
        await chrome.runtime.sendMessage({ to: 'offscreen', cmd: msg.type });
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'goLive' || msg?.type === 'stopGoLive') {
        await chrome.runtime.sendMessage({ to: 'offscreen', cmd: msg.type });
        sendResponse({ ok: true });
        return;
      }
      if (msg?.type === 'requestStop') {
        await stopSession();
        sendResponse({ ok: true });
        return;
      }

      // Offscreen → widget events (routed by tabId).
      if (msg?.to === 'widget' && msg.tabId) {
        try { await chrome.tabs.sendMessage(msg.tabId, msg); } catch {}
        sendResponse({ ok: true });
        return;
      }
    } catch (err) {
      console.error('[bg] error', err);
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true; // keep sendResponse alive for async handler
});

// Cleanup if the active call tab is closed.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeTabId) await stopSession();
});
