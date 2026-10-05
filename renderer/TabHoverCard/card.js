'use strict';
// Tab hover card: fills in the tab's title, site and state, then tells main how
// big the card came out so the view can be sized to it exactly.
(() => {
    const T = (key, fallback) => {
        try { const v = window.Northstar?.i18n?.t(key); return (v && v !== key) ? v : fallback; }
        catch (e) { return fallback; }
    };
    try {
        window.Northstar.i18n.init(window.northstarI18n?.getSync() || {});
    }
    catch (e) { /* English fallbacks below */ }

    const card = document.getElementById('card');
    const title = document.getElementById('title');
    const site = document.getElementById('site');
    const state = document.getElementById('state');

    // What a tab's state means, in words. The chrome sends the state; the
    // sentence is decided here so it can be translated in one place.
    const STATE = {
        slept: () => [T('hovercard.slept', 'Sleeping to save memory. It reloads when you open it.'), false],
        crashed: () => [T('hovercard.crashed', 'This tab stopped working. Reload to try again.'), true],
        audio: () => [T('hovercard.audio', 'Playing audio'), false],
        muted: () => [T('hovercard.muted', 'Muted'), false],
        mic: () => [T('hovercard.mic', 'Using your microphone'), true],
        camera: () => [T('hovercard.camera', 'Using your camera'), true],
        private: () => [T('hovercard.private', 'Private tab'), false],
    };

    window.hoverCard?.onData((d) => {
        title.textContent = d.title || d.site || T('hovercard.untitled', 'Untitled');
        site.textContent = d.site || '';
        const s = d.state && STATE[d.state] ? STATE[d.state]() : null;
        state.hidden = !s;
        state.textContent = s ? s[0] : '';
        state.classList.toggle('warn', !!(s && s[1]));
        // Measure after layout settles, then report — main sizes the view to it.
        requestAnimationFrame(() => {
            const r = card.getBoundingClientRect();
            window.hoverCard.reportSize({ seq: d.seq, width: r.width, height: r.height });
        });
    });

    // Enter/exit motion (P1-6): fade with the rest of the overlays.
    const SA = window.Northstar && window.Northstar.surfaceAnim;
    if (card && SA && window.overlayAnim) {
        window.overlayAnim.onEnter(() => SA.enterCard(card));
        window.overlayAnim.onLeave(() => SA.exitCard(card, () => window.overlayAnim.leaveDone()));
    }
})();
