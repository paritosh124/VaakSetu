// Dedicated permission page. Runs in a normal extension tab so Chrome's
// permission prompt doesn't kill the invoking context (as happens in popups).
//
// Flow:
//   1. Read target tabId from ?tabId=... in the URL.
//   2. On "Grant", call getUserMedia to trigger the Chrome prompt.
//   3. On success: stop tracks, send {type:'start', tabId} to background,
//      then close this tab.
//   4. On denial/dismissal: show retry instructions.
const statusEl = document.getElementById('status');
const grantBtn = document.getElementById('grantBtn');
const cancelBtn = document.getElementById('cancelBtn');

const params = new URLSearchParams(location.search);
const tabId = Number(params.get('tabId'));

function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + cls;
}

async function requestMic() {
  grantBtn.disabled = true;
  setStatus('Waiting for Chrome prompt — click Allow.', '');
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    setStatus('Permission granted. Starting translator…', 'ok');

    if (tabId) {
      await chrome.runtime.sendMessage({ type: 'start', tabId });
    }
    // Close this tab — extensions can close tabs they created.
    const me = await chrome.tabs.getCurrent();
    if (me?.id) chrome.tabs.remove(me.id);
  } catch (err) {
    grantBtn.disabled = false;
    if (err.name === 'NotAllowedError' || /dismissed|denied/i.test(err.message)) {
      setStatus('Permission was not granted. Click the button again, then choose Allow.', 'err');
    } else {
      setStatus(`Error: ${err.message}`, 'err');
    }
  }
}

grantBtn.addEventListener('click', requestMic);
cancelBtn.addEventListener('click', async () => {
  const me = await chrome.tabs.getCurrent();
  if (me?.id) chrome.tabs.remove(me.id);
});

// Auto-trigger on load — most users expect to be prompted immediately.
// Button stays visible for retry on dismiss/deny.
requestMic();
