/**
 * Overlay enter/exit motion (P1-6) — shared by every floating surface page.
 *
 * Overlays are separate WebContentsViews; the main process shows one with
 * setVisible(true), which is INSTANT. So the fade lives inside the overlay's own
 * page: enterCard() runs when the panel is (re)shown, exitCard() runs the close
 * fade and calls back when it's safe for main to hide the view.
 *
 * Translate only, never scale — the shadow gutter of the dropdown is measured
 * exactly (ipc/suggestions.js) and scaling a card would clip it (CLAUDE.md:
 * shadow gutters). The classes live in renderer/styles/surface.css; the default
 * card is fully visible, so a page that never calls these is unaffected.
 *
 * UMD-ish wrapper so tests/unit.js can require the class-sequencing logic.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports)
        module.exports = api;
    root.Northstar = root.Northstar || {};
    root.Northstar.surfaceAnim = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function reducedMotion() {
        try {
            return typeof matchMedia === 'function' &&
                matchMedia('(prefers-reduced-motion: reduce)').matches;
        }
        catch { return false; }
    }

    const EXIT_FALLBACK_MS = 400; // if transitionend never fires, don't hang

    /**
     * Fade a freshly-shown card in: start at opacity 0 / -4px, then on the next
     * painted frame transition to resting. No-op (card simply shown) under
     * reduced motion or without a card.
     */
    function enterCard(el) {
        if (!el || reducedMotion())
            return;
        el.classList.remove('surface-out');
        el.classList.add('surface-enter');
        const play = () => {
            el.classList.add('surface-in');
            el.classList.remove('surface-enter');
            let done = false;
            const end = () => {
                if (done) return;
                done = true;
                el.classList.remove('surface-in'); // back to the resting default
                el.removeEventListener && el.removeEventListener('transitionend', end);
            };
            el.addEventListener && el.addEventListener('transitionend', end);
            setTimeout(end, EXIT_FALLBACK_MS);
        };
        // Two frames so the start state is painted before the transition begins.
        if (typeof requestAnimationFrame === 'function')
            requestAnimationFrame(() => requestAnimationFrame(play));
        else
            play();
    }

    /**
     * Play the close fade, then call `done` so main can setVisible(false). Under
     * reduced motion (or no card) `done` fires immediately. A timeout guarantees
     * `done` is always called, so a dropped transitionend can never leave a
     * panel stuck on screen.
     */
    function exitCard(el, done) {
        const finish = typeof done === 'function' ? done : function () {};
        if (!el || reducedMotion()) {
            finish();
            return;
        }
        el.classList.remove('surface-enter', 'surface-in');
        el.classList.add('surface-out');
        let fired = false;
        const end = () => {
            if (fired) return;
            fired = true;
            el.removeEventListener && el.removeEventListener('transitionend', end);
            el.classList.remove('surface-out');
            finish();
        };
        el.addEventListener && el.addEventListener('transitionend', end);
        setTimeout(end, EXIT_FALLBACK_MS);
    }

    return { enterCard, exitCard, reducedMotion };
});
