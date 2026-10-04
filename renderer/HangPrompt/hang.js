'use strict';
// The hang prompt (P2-3): a tab-scoped overlay replacing the native message box.
// "Wait" (default) just dismisses; "Stop page" tells main to kill the renderer.
(() => {
    const T = (key, fallback) => {
        try { const v = window.Northstar?.i18n?.t(key); return (v && v !== key) ? v : fallback; }
        catch (e) { return fallback; }
    };
    try {
        window.Northstar.i18n.init(window.northstarI18n?.getSync() || {});
        window.Northstar.i18n.apply(document);
    }
    catch (e) { /* labels fall back to the English in the markup */ }

    const card = document.getElementById('panel');
    const msg = document.getElementById('hang-msg');
    const wait = document.getElementById('wait');
    const stop = document.getElementById('stop');

    window.hangPrompt?.onData(({ host }) => {
        msg.textContent = T('hang.title', '{host} isn’t responding').replace('{host}', host || 'This page');
    });
    wait.addEventListener('click', () => window.hangPrompt.wait());
    stop.addEventListener('click', () => window.hangPrompt.stop());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.hangPrompt.wait(); });

    // Enter/exit motion (P1-6): fade the card in/out with the rest of the overlays.
    const SA = window.Northstar && window.Northstar.surfaceAnim;
    if (card && SA && window.overlayAnim) {
        window.overlayAnim.onEnter(() => { SA.enterCard(card); try { wait.focus(); } catch (e) { } });
        window.overlayAnim.onLeave(() => SA.exitCard(card, () => window.overlayAnim.leaveDone()));
    }
    try { wait.focus(); } catch (e) { }
})();
