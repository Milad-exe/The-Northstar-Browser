// Moved out of index.html so the page can run under script-src 'self'.
try { window.Northstar.i18n.init((window.northstarSettings?.getSync() || {}).i18n || {}); window.Northstar.i18n.apply(document); } catch {}
const T = (k, v) => { try { return window.Northstar.i18n.t(k, v); } catch { return k; } };
const p = new URLSearchParams(location.search);
const failedUrl = p.get('url') || '';
const host = p.get('host') || '';
const fingerprint = p.get('fingerprint') || '';

document.getElementById('title').textContent = p.get('title') || 'This connection is not private';
document.getElementById('detail').textContent = p.get('detail') || '';
document.getElementById('host').textContent = host;
document.getElementById('proceed-host').textContent = host;
document.getElementById('code').textContent = p.get('error') || '';
document.title = (p.get('title') || 'Connection is not private');

const fmt = (iso) => { if (!iso) return '—'; try { return window.Northstar.i18n.dateTime(iso); } catch { return iso; } };
const rows = [
  [T('cert.issuedTo'), p.get('subject')],
  [T('cert.issuedBy'), p.get('issuer')],
  [T('cert.validFrom'), fmt(p.get('validFrom'))],
  [T('cert.validTo'), fmt(p.get('validTo'))],
  [T('cert.fingerprint'), fingerprint],
];
const cert = document.getElementById('cert');
for (const [label, value] of rows) {
  const row = document.createElement('div');
  const l = document.createElement('span'); l.textContent = label;
  const v = document.createElement('span'); v.textContent = value || '—';
  row.append(l, v);
  cert.appendChild(row);
}

const adv = document.getElementById('advanced');
document.getElementById('adv-toggle').addEventListener('click', (e) => {
  const open = adv.classList.toggle('open');
  e.target.textContent = T('cert.advanced') + (open ? ' ▾' : ' ▸');
  e.target.setAttribute('aria-expanded', String(open));
});

document.getElementById('btn-back').addEventListener('click', () => window.electronAPI.activeTabGoBack());
document.getElementById('btn-retry').addEventListener('click', () => {
  if (failedUrl) window.electronAPI.navigateActiveTab(failedUrl);
});
document.getElementById('btn-proceed').addEventListener('click', () => {
  window.certWarning.proceed(host, fingerprint, failedUrl);
});
