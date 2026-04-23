import { INDIAN_LANGS, INTL_LANGS } from '../lib/config.js';

const agentLangEl    = document.getElementById('agentLang');
const customerLangEl = document.getElementById('customerLang');
const agentVoiceEl   = document.getElementById('agentVoice');
const custVoiceEl    = document.getElementById('customerVoice');
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
};

async function init() {
  const saved = await chrome.storage.local.get(['agentLang','customerLang','agentVoice','customerVoice','running']);
  fillLangs(agentLangEl,    saved.agentLang    || DEFAULTS.agentLang);
  fillLangs(customerLangEl, saved.customerLang || DEFAULTS.customerLang);
  agentVoiceEl.value = saved.agentVoice   || DEFAULTS.agentVoice;
  custVoiceEl.value  = saved.customerVoice|| DEFAULTS.customerVoice;

  setRunning(!!saved.running);

  agentLangEl.addEventListener('change',    (e) => chrome.storage.local.set({ agentLang:    e.target.value }));
  customerLangEl.addEventListener('change', (e) => chrome.storage.local.set({ customerLang: e.target.value }));
  agentVoiceEl.addEventListener('change',   (e) => chrome.storage.local.set({ agentVoice:   e.target.value }));
  custVoiceEl.addEventListener('change',    (e) => chrome.storage.local.set({ customerVoice:e.target.value }));

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
      const resp = await chrome.runtime.sendMessage({ type: 'start', tabId: tab.id });
      if (resp && resp.error) throw new Error(resp.error);
      setRunning(true);
    }
  } catch (err) {
    statusLine.textContent = err.message || String(err);
    statusLine.classList.add('error');
  } finally {
    toggleBtn.disabled = false;
  }
}

init();
