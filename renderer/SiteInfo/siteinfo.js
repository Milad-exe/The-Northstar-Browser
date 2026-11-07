"use strict";
// IIFE: compiled as a classic <script>; the wrapper keeps this page's
// top-level names out of the shared global scope.
(() => {
    const T = (key, fallback) => {
        try { const v = window.Northstar?.i18n?.t(key); return (v && v !== key) ? v : fallback; }
        catch (e) { return fallback; }
    };
    try {
        window.Northstar.i18n.init(window.northstarI18n?.getSync() || {});
        window.Northstar.i18n.apply(document);
    }
    catch (e) { window.northstarLog?.debug('siteinfo', 'i18n: ' + e); }
    const api = window.siteInfoApi;
    const LOCK = '<svg width="15" height="15" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z"/></svg>';
    const WARN = '<svg width="16" height="16" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M236.8,188.09,149.35,36.22h0a24.76,24.76,0,0,0-42.7,0L19.2,188.09a23.51,23.51,0,0,0,0,23.72A24.35,24.35,0,0,0,40.55,224h174.9a24.35,24.35,0,0,0,21.33-12.19A23.51,23.51,0,0,0,236.8,188.09ZM222.93,203.8a8.5,8.5,0,0,1-7.48,4.2H40.55a8.5,8.5,0,0,1-7.48-4.2,7.59,7.59,0,0,1,0-7.72L120.52,44.21a8.75,8.75,0,0,1,15,0l87.45,151.87A7.59,7.59,0,0,1,222.93,203.8ZM120,144V104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,180Z"/></svg>';
    const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
    function permRow(p) {
        const row = document.createElement('div');
        row.className = 'perm';
        const label = document.createElement('span');
        label.className = 'perm-label';
        label.textContent = p.label;
        // Three explicit states. The default is "Ask" (block-by-default: the site
        // must prompt before using the resource) — it must NOT read as "Allow".
        const seg = document.createElement('div');
        seg.className = 'seg';
        const ask = document.createElement('button');
        ask.textContent = T('site.ask', 'Ask');
        const allow = document.createElement('button');
        allow.textContent = T('site.allow', 'Allow');
        const block = document.createElement('button');
        block.textContent = T('site.block', 'Block');
        const paint = (state) => {
            const s = (state === 'allow' || state === 'block') ? state : 'ask';
            ask.classList.toggle('on', s === 'ask');
            allow.classList.toggle('on', s === 'allow');
            block.classList.toggle('on', s === 'block');
        };
        paint(p.state);
        // 'ask' clears any stored decision (Features/site-permissions.js#set).
        ask.addEventListener('click', () => { paint('ask'); api.setPermission(p.name, 'ask'); });
        allow.addEventListener('click', () => { paint('allow'); api.setPermission(p.name, 'allow'); });
        block.addEventListener('click', () => { paint('block'); api.setPermission(p.name, 'block'); });
        seg.appendChild(ask);
        seg.appendChild(allow);
        seg.appendChild(block);
        row.appendChild(label);
        row.appendChild(seg);
        return row;
    }
    async function render() {
        let info = {};
        try {
            info = await api.getInfo();
        }
        catch (e) { window.northstarLog?.debug('siteinfo', 'render: ' + e); }
        const conn = document.getElementById('conn');
        conn.className = 'conn ' + (info.secure ? 'secure' : 'insecure');
        conn.innerHTML =
            `<span class="conn-icon">${info.secure ? LOCK : WARN}</span>` +
                `<div><div class="conn-title">${info.secure ? T('site.secure', 'Connection is secure') : T('site.insecure', 'Connection is not secure')}</div>` +
                `<div class="host">${esc(info.host)}</div></div>`;
        // Protections shield — checked = protections ON for this site.
        const shieldToggle = document.getElementById('shield-toggle');
        const shieldDesc = document.getElementById('shield-desc');
        shieldToggle.checked = !info.protectionOff;
        shieldDesc.textContent = info.protectionOff
            ? T('site.protectionsOff', 'Protections are off for this site')
            : T('site.protectionsOn', 'Blocking ads and trackers on this site');
        shieldToggle.addEventListener('change', () => {
            // Persist + close + reload happen main-side.
            api.setProtection(!shieldToggle.checked);
        });
        const perms = document.getElementById('perms');
        perms.innerHTML = '';
        const list = info.permissions || [];
        if (list.length)
            list.forEach(p => perms.appendChild(permRow(p)));
        else
            perms.innerHTML = `<div class="perm-empty">${esc(T('site.noPermissions', 'No permissions requested'))}</div>`;
        const clearBtn = document.getElementById('clear');
        if (typeof info.cookieCount === 'number' && info.cookieCount > 0) {
            clearBtn.textContent = `${T('site.clear', 'Clear cookies and site data')} (${info.cookieCount})`;
        }
        clearBtn.addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = T('site.clearing', 'Clearing…');
            try {
                await api.clearData();
            }
            catch (e) { window.northstarLog?.debug('siteinfo', 'render: ' + e); }
            btn.textContent = T('site.cleared', 'Cleared');
            setTimeout(() => api.close(), 700);
        });
        // Size the overlay view to the card's actual height.
        requestAnimationFrame(() => {
            const h = document.getElementById('card').getBoundingClientRect().height;
            api.resize(h + 14);
        });
    }
    document.addEventListener('DOMContentLoaded', render);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape')
        api.close(); });
})();
