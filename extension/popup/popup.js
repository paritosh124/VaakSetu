import { INDIAN_LANGS, INTL_LANGS } from '../lib/config.js';

const agentLangEl    = document.getElementById('agentLang');
const customerLangEl = document.getElementById('customerLang');
const agentVoiceEl   = document.getElementById('agentVoice');
const custVoiceEl    = document.getElementById('customerVoice');
const sinkAgentEl    = document.getElementById('sinkAgent');
const sinkCustomerEl = document.getElementById('sinkCustomer');
const toggleBtn      = document.getElementById('toggleBtn');
const statusLine     = document.getElementById('statusLine');

function fillLangs(sel, selected) {
  for (const group of [['Indian', INDIAN_LANGS], ['International', INTL_LANGS]]) {
    const og = document.createElement('optgroup');
    og.label = group[0];
    for (const l of group[1]) {
      const opt = document.createElement('option');
      opt.value = l.code;
      opt.textContent = `${l.native} · ${l.name}`;
      if (l.code === selected) opt.selected = true;
      og.appendChild(opt);
    }
    sel.appendChild(og);
  }
}

const DEFAULTS = {
  agentLang:    'en-IN',
  customerLang: 'hi-IN',
  agentVoice:   'male',
  customerVoice:'female',
  sinkAgent:    'default',  // where agent-speech translation plays (→ Meet's mic; usually VCC)
  sinkCustomer: 'default',  // where customer-speech translation plays (→ agent's ears; headphones)
};

async function fillOutputDevices(selectEl, selected) {
  // enumerateDevices needs mic permission to reveal labels; if denied we still
  // list generic device IDs so the user can pick by position.
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outs = devices.filter((d) => d.kind === 'audiooutput');
    for (const d of outs) {
      if (d.deviceId === 'default') continue;
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `Output ${d.deviceId.slice(0, 8)}`;
      if (d.deviceId === selected) opt.selected = true;
      selectEl.appendChild(opt);
    }
    if (selected === 'default') selectEl.value = 'default';
  } catch {
    // No permission yet — dropdown stays with just "System default".
  }
}

async function init() {
  const saved = await chrome.storage.local.get([
    'agentLang','customerLang','agentVoice','customerVoice',
    'sinkAgent','sinkCustomer','outputSinkId','running',
  ]);
  fillLangs(agentLangEl,    saved.agentLang    || DEFAULTS.agentLang);
  fillLangs(customerLangEl, saved.customerLang || DEFAULTS.customerLang);
  agentVoiceEl.value = saved.agentVoice   || DEFAULTS.agentVoice;
  custVoiceEl.value  = saved.customerVoice|| DEFAULTS.customerVoice;
  // Migrate old single-sink preference to the "customer hears" side (it was the
  // only output, and most users previously aimed that at a VCC / headphones).
  const savedSinkAgent    = saved.sinkAgent    ?? saved.outputSinkId ?? DEFAULTS.sinkAgent;
  const savedSinkCustomer = saved.sinkCustomer ?? DEFAULTS.sinkCustomer;
  await Promise.all([
    fillOutputDevices(sinkAgentEl,    savedSinkAgent),
    fillOutputDevices(sinkCustomerEl, savedSinkCustomer),
  ]);

  setRunning(!!saved.running);

  agentLangEl.addEventListener('change',    (e) => chrome.storage.local.set({ agentLang:    e.target.value }));
  customerLangEl.addEventListener('change', (e) => chrome.storage.local.set({ customerLang: e.target.value }));
  agentVoiceEl.addEventListener('change',   (e) => chrome.storage.local.set({ agentVoice:   e.target.value }));
  custVoiceEl.addEventListener('change',    (e) => chrome.storage.local.set({ customerVoice:e.target.value }));
  sinkAgentEl.addEventListener('change',    (e) => chrome.storage.local.set({ sinkAgent:    e.target.value }));
  sinkCustomerEl.addEventListener('change', (e) => chrome.storage.local.set({ sinkCustomer: e.target.value }));

  toggleBtn.addEventListener('click', onToggle);
}

function setRunning(running) {
  if (running) {
    toggleBtn.textContent = 'Stop translator';
    toggleBtn.classList.add('stop');
    statusLine.textContent = 'Running. Use the floating widget on the call tab.';
    statusLine.classList.remove('error');
  } else {
    toggleBtn.textContent = 'Start translator';
    toggleBtn.classList.remove('stop');
    statusLine.textContent = '';
  }
}

async function getMicState() {
  // Returns 'granted' | 'prompt' | 'denied' | 'unknown'
  try {
    const res = await navigator.permissions.query({ name: 'microphone' });
    return res.state;
  } catch {
    return 'unknown';
  }
}

async function openPermissionTab(tabId) {
  // Chrome closes the popup the moment a native permission prompt steals focus,
  // which rejects getUserMedia with "Permission dismissed". A normal extension
  // tab stays alive through the prompt, so we route the grant through there.
  const url = chrome.runtime.getURL(`permission/permission.html?tabId=${tabId}`);
  await chrome.tabs.create({ url, active: true });
}

async function onToggle() {
  toggleBtn.disabled = true;
  const { running } = await chrome.storage.local.get('running');

  try {
    if (running) {
      await chrome.runtime.sendMessage({ type: 'stop' });
      setRunning(false);
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('No active tab.');

      const state = await getMicState();
      if (state === 'granted') {
        // Permission already unlocked for this extension origin — start directly.
        const resp = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id });
        if (resp && resp.error) throw new Error(resp.error);
        setRunning(true);
        return;
      }

      if (state === 'denied') {
        throw new Error(
          'Microphone is blocked. Open chrome://settings/content/microphone, find this extension, set to Allow, then retry.'
        );
      }

      // 'prompt' or 'unknown' → open dedicated permission tab; it will
      // trigger Chrome's prompt, grant, send the start message, and mark
      // running=true itself. We don't optimistically flag running here
      // because denial/cancel would leave stale state.
      statusLine.textContent = 'Opening permission tab — grant access there, then return.';
      statusLine.classList.remove('error');
      await openPermissionTab(tab.id);
    }
  } catch (err) {
    statusLine.textContent = err.message || String(err);
    statusLine.classList.add('error');
  } finally {
    toggleBtn.disabled = false;
  }
}

init();
