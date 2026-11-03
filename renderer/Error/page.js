// Moved out of index.html so the page can run under script-src 'self'.
try { window.Northstar.i18n.init((window.northstarSettings?.getSync() || {}).i18n || {}); window.Northstar.i18n.apply(document); } catch {}
const T = (k, f) => {
  try { const v = window.Northstar?.i18n?.t(k); return (v && v !== k) ? v : f; }
  catch { return f; }
};
const params = new URLSearchParams(location.search);
const failedUrl = params.get('url') || '';
const code = params.get('code') || '';
const desc = params.get('desc') || '';

if (failedUrl) document.getElementById('url').textContent = failedUrl;
// ERR_NAME_NOT_RESOLVED etc. — only when it looks like one.
if (/^ERR_[A-Z_]+$/.test(desc)) document.getElementById('code').textContent = desc;

// Plain-language copy per net error (renderer/lib/util.js errorCopy).
const copy = window.Northstar.util.errorCopy(code);
const title = T(`error.${copy.key}.title`, copy.title);
document.getElementById('title').textContent = title;
document.getElementById('detail').textContent = T(`error.${copy.key}.detail`, copy.detail);
document.title = title;

// Use the tab's navigation API (available via preload) instead of window history
document.getElementById('btn-retry').addEventListener('click', () => {
  if (failedUrl) window.electronAPI.navigateActiveTab(failedUrl);
});
document.getElementById('btn-back').addEventListener('click', () => {
  window.electronAPI.activeTabGoBack();
});
