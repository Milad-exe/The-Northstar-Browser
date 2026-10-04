"use strict";
/* The page-actions panel.

   It owns no state. The chrome already knows which actions apply to the tab you
   are on (it is the thing that used to show and hide the toolbar icons), so it
   sends that down and this renders it. Pressing a row sends the action back and
   closes — the panel is a remote control, not a second place where the answer
   to "is this bookmarked?" lives. */
(() => {
    const api = window.overlayPageActions;
    if (!api)
        return;

    const el = (id) => document.getElementById(id);
    /* Await the action before closing. Both are IPC invokes on different
       channels, and firing them back to back left the close racing the run —
       the panel could be torn down while its own action was still in flight. */
    const send = async (action) => {
        try { await api.run(action); }
        finally { api.close(); }
    };

    for (const [id, action] of [
        ['pa-share', 'copy-link'],
        ['pa-reader', 'reader'],
        ['pa-pip', 'pip'],
        ['pa-bookmark', 'bookmark'],
        ['pa-extensions', 'extensions'],
        ['pa-downloads', 'downloads'],
        ['pa-focus', 'focus'],
        ['pa-security', 'site-info'],
    ]) {
        el(id)?.addEventListener('click', () => send(action));
    }

    /* State from the chrome: which actions apply, and what the page is.
       `available` is the set the toolbar would have SHOWN; anything outside it
       is dimmed rather than hidden, so the panel keeps one shape. */
    api.onState((s) => {
        const has = new Set(s?.available || []);
        for (const [id, key] of [['pa-reader', 'reader'], ['pa-pip', 'pip'], ['pa-downloads', 'downloads']]) {
            const b = el(id);
            if (b)
                b.disabled = !has.has(key);
        }
        el('pa-bookmark')?.classList.toggle('on', !!s?.bookmarked);
        el('pa-focus')?.classList.toggle('on', !!s?.focus);

        const sec = el('pa-security');
        const secure = !!s?.secure;
        sec?.classList.toggle('secure', secure);
        const text = el('pa-sec-text');
        if (text)
            text.textContent = s?.internal ? 'Northstar page' : (secure ? 'Connection is secure' : 'Not secure');
        const host = el('pa-sec-host');
        if (host)
            host.textContent = s?.host || '';
    });

    // Escape closes wherever focus happens to be.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape')
            return;
        e.preventDefault();
        api.close();
    }, true);
})();
// Overlay enter/exit motion (P1-6): fade the card in on show, play the close
// fade on hide then let main hide the view. No-ops cleanly if the bits are
// missing (card stays visible), and collapses under reduced motion.
(function () {
    try {
        var card = document.getElementById('panel');
        var SA = window.Northstar && window.Northstar.surfaceAnim;
        if (card && SA && window.overlayAnim) {
            window.overlayAnim.onEnter(function () { SA.enterCard(card); });
            window.overlayAnim.onLeave(function () { SA.exitCard(card, function () { window.overlayAnim.leaveDone(); }); });
        }
    }
    catch (e) { /* animation is non-essential */ }
})();
