// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
(function () {
  const S = 'stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" fill="none"';
  const ICONS = {
    camera:       `<svg viewBox="0 0 24 24" ${S}><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
    microphone:   `<svg viewBox="0 0 24 24" ${S}><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/></svg>`,
    location:     `<svg viewBox="0 0 24 24" ${S}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
    notifications:`<svg viewBox="0 0 24 24" ${S}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>`,
    screen:       `<svg viewBox="0 0 24 24" ${S}><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
    clipboard:    `<svg viewBox="0 0 24 24" ${S}><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/></svg>`,
    midi:         `<svg viewBox="0 0 24 24" ${S}><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="6" x2="6" y2="14"/><line x1="10" y1="6" x2="10" y2="14"/><line x1="14" y1="6" x2="14" y2="14"/><line x1="18" y1="6" x2="18" y2="14"/></svg>`,
    external:     `<svg viewBox="0 0 24 24" ${S}><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
    generic:      `<svg viewBox="0 0 24 24" ${S}><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  };

  const iconEl    = document.getElementById('icon');
  const qEl       = document.getElementById('q');
  const hostEl    = document.getElementById('host');
  const rememberRow = document.getElementById('remember-row');
  const rememberEl  = document.getElementById('remember');
  const allowBtn  = document.getElementById('allow');
  const blockBtn  = document.getElementById('block');

  let current = null;

  function hostOf(origin) {
    try { return new URL(origin).host; } catch { return origin || 'This site'; }
  }

  function reportHeight() {
    requestAnimationFrame(() => {
      const h = document.getElementById('card').getBoundingClientRect().height;
      try { window.permissionUI.resize(h + 12); } catch {}
    });
  }

  function render(data) {
    current = data;
    iconEl.innerHTML = ICONS[data.iconType] || ICONS.generic;
    qEl.textContent  = `Allow this site to ${data.action}?`;
    hostEl.textContent = hostOf(data.origin);
    // The "Remember" checkbox is meaningless in private tabs (nothing persists)
    // and for ask-every-time permissions — hide it there.
    if (data.checkbox === false) rememberRow.style.display = 'none';
    else { rememberRow.style.display = ''; rememberEl.checked = true; }
    reportHeight();
  }

  // dismissed=true (Esc / click-away) denies this request without recording a
  // decision — the site may ask again. Allow/Block are explicit and stick.
  function decide(allowed, dismissed = false) {
    if (!current) return;
    const remember = !dismissed && rememberRow.style.display !== 'none' && rememberEl.checked;
    const id = current.id;
    current = null;
    try { window.permissionUI.decide(id, allowed, remember, dismissed); } catch {}
  }

  allowBtn.addEventListener('click', () => decide(true));
  blockBtn.addEventListener('click', () => decide(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') decide(false, true);
    if (e.key === 'Enter')  decide(true);
  });

  window.permissionUI.onData(render);
})();
})();
