// Content-script widget — push-to-talk UI injected into every tab.
// Hidden until the background says "show" (after the user starts a session).
//
// NOTE: content scripts run on every page, so do minimal work at load time.
// The widget DOM is only built on first 'show' event.

(function () {
  if (window.__vaaksetuWidgetLoaded) return;
  window.__vaaksetuWidgetLoaded = true;

  const LANG_LABEL = {
    'hi-IN':'Hindi','en-IN':'English','bn-IN':'Bengali','gu-IN':'Gujarati','kn-IN':'Kannada',
    'ml-IN':'Malayalam','mr-IN':'Marathi','or-IN':'Odia','pa-IN':'Punjabi','ta-IN':'Tamil','te-IN':'Telugu',
    es:'Spanish',fr:'French',de:'German',ja:'Japanese',zh:'Chinese',ar:'Arabic',pt:'Portuguese',
    ru:'Russian',it:'Italian',ko:'Korean',nl:'Dutch',tr:'Turkish',pl:'Polish',sv:'Swedish',
    th:'Thai',vi:'Vietnamese',id:'Indonesian',uk:'Ukrainian',
  };

  let root = null;
  let recording = null;
  let live = false;
  const partialBubbles = {}; // who -> element
  const transcript = [];     // { ts, who, srcLabel, tgtLabel, pivotText, translatedText }

  function build() {
    root = document.createElement('div');
    root.id = 'vaaksetu-widget';
    root.innerHTML = `
      <div class="vs-head">
        <span class="vs-title">VaakSetu</span>
        <button class="vs-download" title="Download transcript">⭳</button>
        <button class="vs-close" title="Close">×</button>
      </div>
      <div class="vs-status"></div>
      <div class="vs-feed"></div>
      <div class="vs-controls">
        <button class="vs-btn vs-ptt vs-customer" data-who="customer">Customer speaks<small id="vs-cust-label"></small></button>
        <button class="vs-btn vs-ptt vs-agent"    data-who="agent">Agent speaks<small id="vs-agent-label"></small></button>
      </div>
      <div class="vs-live-row">
        <button class="vs-golive">Go Live — hands-free</button>
      </div>
    `;
    document.documentElement.appendChild(root);

    root.querySelector('.vs-close').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'requestStop' }).catch(() => {});
    });

    root.querySelector('.vs-download').addEventListener('click', downloadTranscript);

    for (const btn of root.querySelectorAll('.vs-ptt')) {
      const who = btn.dataset.who;
      const onDown = (e) => { e.preventDefault(); startTalk(who, btn); };
      const onUp   = (e) => { e.preventDefault(); stopTalk(btn); };
      btn.addEventListener('mousedown',  onDown);
      btn.addEventListener('mouseup',    onUp);
      btn.addEventListener('mouseleave', onUp);
      btn.addEventListener('touchstart', onDown, { passive: false });
      btn.addEventListener('touchend',   onUp,   { passive: false });
      btn.addEventListener('touchcancel',onUp,   { passive: false });
    }

    root.querySelector('.vs-golive').addEventListener('click', toggleGoLive);

    makeDraggable(root, root.querySelector('.vs-head'));
  }

  function show({ agentLang, customerLang }) {
    if (!root) build();
    if (agentLang)    root.querySelector('#vs-agent-label').textContent = LANG_LABEL[agentLang] || agentLang;
    if (customerLang) root.querySelector('#vs-cust-label').textContent  = LANG_LABEL[customerLang] || customerLang;
    root.classList.add('vs-open');
  }

  function hide() {
    root?.classList.remove('vs-open');
  }

  function setStatus(text, isError = false) {
    if (!root) return;
    const s = root.querySelector('.vs-status');
    s.textContent = text || '';
    s.classList.toggle('vs-error', !!isError);
  }

  function appendMessage(msg) {
    if (!root) return;
    clearPartial(msg.who);
    transcript.push({
      ts: Date.now(),
      who: msg.who,
      srcLabel: msg.srcLabel || '',
      tgtLabel: msg.tgtLabel || '',
      pivotText: msg.pivotText || '',
      translatedText: msg.translatedText || '',
    });
    const feed = root.querySelector('.vs-feed');
    const el = document.createElement('div');
    el.className = `vs-msg ${msg.who === 'customer' ? 'vs-customer' : ''}`;
    const label = `${msg.srcLabel} → ${msg.tgtLabel}`;
    el.innerHTML = `
      <div class="vs-label"></div>
      <div class="vs-translated"></div>
      <div class="vs-pivot"></div>
    `;
    el.querySelector('.vs-label').textContent = label;
    el.querySelector('.vs-translated').textContent = msg.translatedText || '';
    if (msg.pivotText && msg.pivotText !== msg.translatedText) {
      el.querySelector('.vs-pivot').textContent = `(${msg.pivotText})`;
    }
    feed.appendChild(el);
    feed.scrollTop = feed.scrollHeight;
  }

  function downloadTranscript() {
    if (!transcript.length) {
      setStatus('No transcript yet — start a conversation first.', true);
      return;
    }
    const lines = ['VaakSetu conversation transcript', '================================', ''];
    for (const t of transcript) {
      const when = new Date(t.ts).toLocaleString();
      lines.push(`[${when}] ${t.srcLabel} → ${t.tgtLabel}`);
      lines.push(`  ${t.translatedText}`);
      if (t.pivotText && t.pivotText !== t.translatedText) lines.push(`  (pivot: ${t.pivotText})`);
      lines.push('');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `vaaksetu-transcript-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function showPartial(who, text) {
    if (!root || !text) return;
    const feed = root.querySelector('.vs-feed');
    let bubble = partialBubbles[who];
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = `vs-partial ${who === 'customer' ? 'vs-customer' : 'vs-agent'}`;
      feed.appendChild(bubble);
      partialBubbles[who] = bubble;
    }
    bubble.textContent = text;
    feed.scrollTop = feed.scrollHeight;
  }

  function clearPartial(who) {
    if (who && partialBubbles[who]) {
      partialBubbles[who].remove();
      delete partialBubbles[who];
      return;
    }
    for (const k of Object.keys(partialBubbles)) {
      partialBubbles[k].remove();
      delete partialBubbles[k];
    }
  }

  function toggleGoLive() {
    const type = live ? 'stopGoLive' : 'goLive';
    chrome.runtime.sendMessage({ type }).catch(() => {});
  }

  function setLive(on) {
    live = !!on;
    if (!root) return;
    const btn = root.querySelector('.vs-golive');
    btn.textContent = live ? 'Leave live conversation' : 'Go Live — hands-free';
    btn.classList.toggle('vs-live-on', live);
    root.querySelectorAll('.vs-ptt').forEach((b) => { b.disabled = live; });
    if (!live) clearPartial();
  }

  function startTalk(who, btn) {
    if (recording) return;
    recording = who;
    btn.classList.add('vs-recording');
    chrome.runtime.sendMessage({ type: who === 'customer' ? 'recordCustomer' : 'recordAgent' }).catch(() => {});
  }

  function stopTalk(btn) {
    if (!recording) return;
    recording = null;
    btn.classList.remove('vs-recording');
    chrome.runtime.sendMessage({ type: 'stopRecord' }).catch(() => {});
  }

  function makeDraggable(el, handle) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('vs-close')) return;
      if (e.target.classList.contains('vs-download')) return;
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const rect = el.getBoundingClientRect();
      ox = rect.left; oy = rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const nx = ox + (e.clientX - sx);
      const ny = oy + (e.clientY - sy);
      el.style.left = `${nx}px`;
      el.style.top  = `${ny}px`;
      el.style.right = 'auto';
      el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ─── Listen for events from background/offscreen ───────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.event) return;
    switch (msg.event) {
      case 'show':    show(msg); break;
      case 'hide':    hide(); setLive(false); break;
      case 'ready':   setStatus('Ready. Hold a button or click Go Live.'); break;
      case 'status':  setStatus(msg.text || ''); break;
      case 'message': appendMessage(msg); setStatus(''); break;
      case 'partial': showPartial(msg.who, msg.text || ''); break;
      case 'goLive':  setLive(!!msg.on); break;
      case 'error':   setStatus(msg.error, true); break;
    }
  });
})();
