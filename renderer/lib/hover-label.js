/**
 * The chrome's hover label (ui-polish U1-7) — replaces OS tooltips.
 *
 * Native `title` tooltips are OS windows: wrong font, wrong colours, no delay
 * control. This draws one label in the chrome document instead. The catch is
 * that the page is a native WebContentsView stacked OVER the chrome, so a label
 * that overlaps the page card would be hidden behind it. placeHoverLabel tries
 * below → above → left → right and takes the first spot that fits the window
 * and stays off the page card (null when none does — show nothing rather than
 * a hidden label).
 *
 * Every `title` the chrome sets — in markup or later from script — is moved to
 * `data-tip` by a MutationObserver (and becomes the aria-label of an icon-only
 * control), so an OS tooltip cannot come back. Timing: --tooltip-delay before
 * showing; within a 300ms grace after one hides, the next shows at once
 * (moving along the toolbar or tab strip keeps it up, as in Chrome).
 *
 * UMD like util.js: pure placement is required by tests/unit.js.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports)
        module.exports = api;
    root.Northstar = root.Northstar || {};
    root.Northstar.hoverLabel = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const EDGE = 4; // keep this far from the window edge

    const intersects = (a, b) => !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

    /**
     * @param anchor  {left, top, right, bottom} of the hovered control
     * @param size    {width, height} of the label
     * @param vp      {width, height} of the viewport
     * @param avoid   rect the label must not overlap (the page card), or null
     * @param gap     space between control and label
     * @returns {x, y, side} or null
     */
    function placeHoverLabel(anchor, size, vp, avoid, gap = 6) {
        const cx = (anchor.left + anchor.right) / 2;
        const cy = (anchor.top + anchor.bottom) / 2;
        const clampX = (x) => Math.max(EDGE, Math.min(x, vp.width - size.width - EDGE));
        const clampY = (y) => Math.max(EDGE, Math.min(y, vp.height - size.height - EDGE));
        const candidates = [
            ['below', clampX(cx - size.width / 2), anchor.bottom + gap],
            ['above', clampX(cx - size.width / 2), anchor.top - gap - size.height],
            ['left', anchor.left - gap - size.width, clampY(cy - size.height / 2)],
            ['right', anchor.right + gap, clampY(cy - size.height / 2)],
        ];
        for (const [side, x, y] of candidates) {
            const r = { left: x, top: y, right: x + size.width, bottom: y + size.height };
            if (r.left < EDGE - 0.01 || r.top < EDGE - 0.01 || r.right > vp.width - EDGE + 0.01 || r.bottom > vp.height - EDGE + 0.01)
                continue;
            if (intersects(r, avoid))
                continue;
            return { x: Math.round(x), y: Math.round(y), side };
        }
        return null;
    }

    let label = null;
    let opts = null;
    let current = null;     // the element the label is (or is about to be) for
    let timer = null;
    let lastHidden = 0;
    const GRACE_MS = 300;

    function delayMs() {
        try {
            const v = getComputedStyle(document.documentElement).getPropertyValue('--tooltip-delay').trim();
            const n = parseFloat(v);
            if (!Number.isFinite(n)) return 500;
            return /ms$/.test(v) ? n : /s$/.test(v) ? n * 1000 : n;
        }
        catch { return 500; }
    }

    // title → data-tip (+ aria-label for an icon-only control). Opt out with
    // data-native-title on an ancestor.
    function convert(el) {
        if (!el || el.nodeType !== 1 || !el.hasAttribute('title') || el.closest('[data-native-title]'))
            return;
        const t = el.getAttribute('title');
        el.removeAttribute('title');
        if (!t) return;
        el.dataset.tip = t;
        if (!el.getAttribute('aria-label') && !(el.textContent || '').trim())
            el.setAttribute('aria-label', t);
        if (current === el && label && !label.hidden) render(el); // label text follows a live title change
    }
    function sweep(node) {
        if (!node || node.nodeType !== 1) return;
        convert(node);
        node.querySelectorAll?.('[title]').forEach(convert);
    }

    // What to show for `el`: opts.content wins (null = nothing; undefined =
    // fall back to the element's data-tip). Returns an array of lines.
    function linesFor(el) {
        if (opts && typeof opts.content === 'function') {
            const c = opts.content(el);
            if (c === null) return null;
            if (Array.isArray(c)) return c.filter(Boolean);
        }
        const t = el.dataset && el.dataset.tip;
        return t ? [t] : null;
    }

    function render(el) {
        const lines = linesFor(el);
        if (!lines || !lines.length) { hide(); return; }
        label.textContent = '';
        lines.forEach((text, i) => {
            const d = document.createElement('div');
            d.className = i === 0 ? 'hover-label-line' : 'hover-label-sub';
            d.textContent = text;
            label.appendChild(d);
        });
        // Measure off-screen, then place.
        label.style.left = '-9999px';
        label.style.top = '0px';
        label.hidden = false;
        const size = { width: label.offsetWidth, height: label.offsetHeight };
        const a = el.getBoundingClientRect();
        let avoid = null;
        try { avoid = opts && opts.avoid ? opts.avoid() : null; } catch { avoid = null; }
        const at = placeHoverLabel(a, size, { width: innerWidth, height: innerHeight }, avoid, 6);
        if (!at) { hide(); return; }
        label.style.left = at.x + 'px';
        label.style.top = at.y + 'px';
        label.dataset.side = at.side;
        label.classList.add('shown');
    }

    function show(el) {
        clearTimeout(timer);
        current = el;
        // Already showing one (moving straight along the toolbar or tab strip),
        // or one hid moments ago: follow at once. Otherwise wait the delay.
        const showing = label && !label.hidden;
        const wait = (showing || Date.now() - lastHidden < GRACE_MS) ? 0 : delayMs();
        // Following along the toolbar: no delay AND no fade-in.
        if (label) label.classList.toggle('instant', wait === 0);
        timer = setTimeout(() => { if (current === el && el.isConnected) render(el); }, wait);
    }

    function hide() {
        clearTimeout(timer);
        if (label && !label.hidden) {
            label.hidden = true;
            label.classList.remove('shown');
            lastHidden = Date.now();
        }
        current = null;
    }

    const TARGET = '[data-tip], #tabs-container .tab-button';

    function init(options) {
        if (label) return;
        opts = options || {};
        label = document.createElement('div');
        label.className = 'hover-label';
        label.setAttribute('role', 'tooltip');
        label.hidden = true;
        document.body.appendChild(label);
        sweep(document.body);
        new MutationObserver((muts) => {
            for (const m of muts) {
                if (m.type === 'attributes') convert(m.target);
                else m.addedNodes.forEach(sweep);
            }
        }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
        document.addEventListener('pointerover', (e) => {
            const el = e.target.closest && e.target.closest(TARGET);
            if (!el) { if (current) hide(); return; }
            if (el !== current) show(el);
        }, true);
        document.addEventListener('pointerout', (e) => {
            if (!current) return;
            const to = e.relatedTarget;
            if (!to || !current.contains(to)) {
                const next = to && to.closest && to.closest(TARGET);
                if (!next) hide();
            }
        }, true);
        for (const ev of ['pointerdown', 'keydown', 'wheel'])
            document.addEventListener(ev, hide, true);
        window.addEventListener('blur', hide);
    }

    return { placeHoverLabel, init, hide };
});
