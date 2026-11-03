// Moved out of index.html so the page can run under script-src 'self'.
// Localise before reading any label back out of the DOM.
try { window.Northstar.i18n.init((window.northstarSettings?.getSync() || {}).i18n || {}); window.Northstar.i18n.apply(document); } catch {}
const T = (k, v) => { try { return window.Northstar.i18n.t(k, v); } catch { return k; } };
const p = new URLSearchParams(location.search);
const failedUrl = p.get('url') || '';
const reason = p.get('reason') || '';
const killed = p.get('killed') === '1';
if (failedUrl) document.getElementById('url').textContent = failedUrl;
if (reason) document.getElementById('reason').textContent = 'reason: ' + reason;
if (killed) {
  document.getElementById('title').textContent = T('crash.killedTitle');
  document.getElementById('detail').textContent = T('crash.killedDetail');
}
document.getElementById('btn-reload').addEventListener('click', () => {
  if (failedUrl) window.electronAPI.navigateActiveTab(failedUrl);
});
document.getElementById('btn-back').addEventListener('click', () => window.electronAPI.activeTabGoBack());
