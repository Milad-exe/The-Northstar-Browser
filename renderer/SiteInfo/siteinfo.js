const api = window.siteInfoApi;

const LOCK = '<svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M6.5 9V6.5a3.5 3.5 0 017 0V9"/></svg>';
const WARN = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.2L2.8 16h14.4L10 3.2z"/><path d="M10 8.2v3.2M10 13.6v.1"/></svg>';

const esc = (s) => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

function permRow(p) {
    const row = document.createElement('div');
    row.className = 'perm';

    const label = document.createElement('span');
    label.className = 'perm-label';
    label.textContent = p.label;

    const seg = document.createElement('div');
    seg.className = 'seg';
    const allow = document.createElement('button');
    allow.textContent = 'Allow';
    const block = document.createElement('button');
    block.textContent = 'Block';
    const paint = (state) => {
        allow.classList.toggle('on', state !== 'block');
        block.classList.toggle('on', state === 'block');
    };
    paint(p.state);
    allow.addEventListener('click', () => { paint('allow'); api.setPermission(p.name, 'allow'); });
    block.addEventListener('click', () => { paint('block'); api.setPermission(p.name, 'block'); });
    seg.appendChild(allow); seg.appendChild(block);

    row.appendChild(label); row.appendChild(seg);
    return row;
}

async function render() {
    let info = {};
    try { info = await api.getInfo(); } catch {}

    const conn = document.getElementById('conn');
    conn.className = 'conn ' + (info.secure ? 'secure' : 'insecure');
    conn.innerHTML =
        `<span class="conn-icon">${info.secure ? LOCK : WARN}</span>` +
        `<div><div class="conn-title">${info.secure ? 'Connection is secure' : 'Connection is not secure'}</div>` +
        `<div class="host">${esc(info.host)}</div></div>`;

    // Protections shield — checked = protections ON for this site.
    const shieldToggle = document.getElementById('shield-toggle');
    const shieldDesc   = document.getElementById('shield-desc');
    shieldToggle.checked = !info.protectionOff;
    shieldDesc.textContent = info.protectionOff
        ? 'Protections are off for this site'
        : 'Blocking ads & trackers on this site';
    shieldToggle.addEventListener('change', () => {
        // Persist + close + reload happen main-side.
        api.setProtection(!shieldToggle.checked);
    });

    const perms = document.getElementById('perms');
    perms.innerHTML = '';
    const list = info.permissions || [];
    if (list.length) list.forEach(p => perms.appendChild(permRow(p)));
    else perms.innerHTML = '<div class="perm-empty">No permissions requested</div>';

    const clearBtn = document.getElementById('clear');
    if (typeof info.cookieCount === 'number' && info.cookieCount > 0) {
        clearBtn.textContent = `Clear cookies and site data (${info.cookieCount})`;
    }
    clearBtn.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true; btn.textContent = 'Clearing…';
        try { await api.clearData(); } catch {}
        btn.textContent = 'Cleared ✓';
        setTimeout(() => api.close(), 700);
    });

    // Size the overlay view to the card's actual height.
    requestAnimationFrame(() => {
        const h = document.getElementById('card').getBoundingClientRect().height;
        api.resize(h + 14);
    });
}

document.addEventListener('DOMContentLoaded', render);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') api.close(); });
