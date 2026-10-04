/* renderer/lib/theme-editor.js
 *
 * The theme picker and editor, as one mountable instrument.
 *
 * It exists as a module because it is used in two frames: the Appearance
 * section of the Settings page, and the popup that opens from the sidebar's
 * context menu. The logic — the gradient canvas, the draggable pools, the
 * palette, the controls, the save path — is identical in both, and a copy in
 * each would drift the moment one of them got a fix.
 *
 * The model is Zen's: a theme is a set of COLOURS, each pooled at an XY
 * POSITION on a canvas, and the browser wears the blend of them. Position is
 * layout (where a colour pools), which is a different thing from the colour —
 * you drag a pool to move it and pick its colour from the palette. The ground,
 * accent and text tokens are still DERIVED from the colours in the main process
 * (features/theme-derive.js), so a gradient can never make the browser
 * unreadable; positions only shape the wash it wears.
 *
 * Mount it with:
 *
 *   Northstar.themeEditor.mount({
 *     picker,        // element the swatch row is built into
 *     editor,        // element holding the editor markup (see either page)
 *     api,           // the northstarThemes bridge: list/preview/save/remove
 *     setTheme(id),  // how THIS page applies a chosen theme
 *     toast(msg),    // how THIS page reports
 *     currentTheme,  // optional: the id to start selected on
 *     alwaysOpen,    // the editor IS the frame (the popup), not a section
 *     onCancel,      // what "Done" means when alwaysOpen
 *   })
 *
 * Nothing here computes a token. Every colour that reaches the browser is
 * derived in the main process (features/theme-derive.js) — this only needs
 * enough OKLCH to draw the wheel, place a dot and paint a track, and that maths
 * is inlined below because these pages are sandboxed and cannot require it.
 */
(function () {
    'use strict';
    window.Northstar = window.Northstar || {};

    function mount(ctx) {
        // The preset-circle row is OPTIONAL. The picker used to be the "select a
        // theme" row; the model is now a single gradient you edit in place, so
        // both pages drop the row and mount with no picker — the editor IS the
        // theme. Everything that touches `picker` is guarded for its absence.
        const picker = ctx.picker || null;
        const editor = ctx.editor;
        const root = ctx.root || document;
        if (!editor || !ctx.api)
            return null;

        const el = id => root.querySelector('#' + id);
        // `root` may be a document or a fragment; only some of those carry
        // activeElement, and the picker's arrow keys need whichever does.
        const active = () => root.activeElement || document.activeElement;
        const T = ctx.api;
        let current = ctx.currentTheme || 'default';
        let list = [];

        const svg = (paths, w = 24) => {
            const s = `<svg viewBox="0 0 ${w} ${w}" fill="none" stroke="currentColor"
                stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
            const t = document.createElement('template');
            t.innerHTML = s.trim();
            return t.content.firstChild;
        };

        /* ── The presets ─────────────────────────────────────────────────────
         *
         * The circles ARE the themes. Zen and Arc do not keep a growing library
         * of saved themes you pick from — a theme is a property of the space,
         * edited IN PLACE. So there is no swatch grid, no "+", no naming, no
         * "Blue 2, Blue 3". There is a row of PRESET circles (the built-ins and
         * a handful of gradients) you tap to start from, and below it the
         * gradient editor, which edits THIS scope's own theme directly.
         *
         * Every edit writes to one deterministic slot for this scope
         * (ctx.slotId — `custom:global` or `custom:sp<id>`), overwriting it, so
         * the space keeps exactly one editable gradient however much you tweak
         * it. Tapping a preset re-bases the space on that preset; the next edit
         * forks from there. */

        const slotId = ctx.slotId || null;
        let presets = [];

        /* The circle's face: a gradient theme shows its colours blended; a plain
           ground shows its shell. That split is the whole legend — vivid circles
           are gradients, muted ones are solid grounds. */
        function circleBg(t) {
            const cols = (t.seed && Array.isArray(t.seed.colors) && t.seed.colors.length >= 2) ? t.seed.colors : null;
            if (cols)
                return `linear-gradient(135deg, ${cols.join(', ')})`;
            return (t.swatch && t.swatch.shell) || 'var(--surface-2)';
        }

        function circleFor(t) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'theme-preset';
            b.dataset.themeValue = t.id;
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(t.id === current));
            b.tabIndex = t.id === current ? 0 : -1;
            b.setAttribute('aria-label', t.name);
            b.title = t.name;
            const sw = document.createElement('span');
            sw.className = 'theme-preset-sw';
            sw.style.background = circleBg(t);
            b.appendChild(sw);
            // A tick marks the one that is on (chosen in --accent-ink against its
            // own face so it reads on a light and a dark circle alike).
            b.appendChild(svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'));
            b.addEventListener('click', () => choosePreset(t));
            // Hover previews the whole browser in this preset, live (no save).
            b.addEventListener('mouseenter', () => {
                if (t.id === current) return;
                const s = t.seed || t.wheelSeed;
                if (s) { try { T.live?.(s); } catch (e) { } }
            });
            return b;
        }

        // Leaving the row drops any hover preview back to the committed theme.
        picker?.addEventListener('mouseleave', () => { try { T.live?.(null); } catch (e) { } });

        function markCurrent() {
            if (!picker)
                return;
            let anyOn = false;
            for (const b of picker.querySelectorAll('.theme-preset')) {
                const on = b.dataset.themeValue === current;
                if (on) anyOn = true;
                b.classList.toggle('on', on);
                b.setAttribute('aria-checked', String(on));
                b.tabIndex = on ? 0 : -1;
            }
            // Wearing your own edited gradient means no preset is selected — keep
            // one reachable by keyboard anyway.
            if (!anyOn) {
                const first = picker.querySelector('.theme-preset');
                if (first) first.tabIndex = 0;
            }
        }

        /* Tap a preset: the scope wears it now, and the editor re-bases on its
           seed so the next edit forks FROM this preset rather than from whatever
           was last on the canvas. */
        async function choosePreset(t) {
            current = t.id;
            markCurrent();
            try { await T.live?.(null); }
            catch (e) { /* the repaint below is authoritative */ }
            await ctx.setTheme(t.id);
            openEditor(t.seed || t.wheelSeed || null);
            ctx.toast('Theme updated');
        }

        /* The HOST owns which theme is current — it knows whether this editor is
           looking at a space or the global setting. */
        const hostOwnsCurrent = ctx.currentTheme != null;

        /* Rebuild the circles only when the preset SET changes (it never does
           mid-session, but a save broadcasts `themes-changed`, which fires this).
           The selection mark is cheap and always re-applied. */
        let presetSig = null;
        async function refresh() {
            const res = await T.list();
            list = res?.themes || [];
            if (!hostOwnsCurrent)
                current = res?.current || current;
            presets = list.filter(t => t.kind === 'builtin');
            const sig = presets.map(t => `${t.id}~${t.swatch?.shell}`).join('|');
            if (picker && sig !== presetSig) {
                presetSig = sig;
                picker.textContent = '';
                for (const t of presets)
                    picker.appendChild(circleFor(t));
            }
            markCurrent();
        }

        // ── Editor ────────────────────────────────────────────────────────
        // The seed is a list of dots plus three amounts. Everything the
        // palette needs is derived from that in the main process, so this
        // never computes a colour it then has to keep in step.

        /* Mirrored from features/theme-derive.js — change one, change both.
           WHEEL_L is the lightness a newly-added pool colour is minted at, so a
           second colour comes in as a real tint rather than near-black; how dark
           the GROUND sits is its own value on the seed (`level`). */
        const WHEEL_L = 0.72;
        const GROUND_L = { dark: [0.06, 0.30], light: [0.88, 0.98] };
        const GROUND_C_MAX = 0.060;
        const DEFAULT_LEVEL = 0.5;
        const DEFAULT_INTENSITY = 0.7;

        let seed = { mode: 'dark', colors: ['#3a6ea5'], positions: [], intensity: DEFAULT_INTENSITY, grain: 0, level: DEFAULT_LEVEL };
        let activeDot = 0;

        /* The canvas's rendered size is MEASURED, never assumed — it is a square
           that fills the frame, narrower in the popup than in the Settings
           column, and a dot's position is a FRACTION of it. */
        const canvasSize = () => {
            const c = el('te-canvas');
            return { w: c?.clientWidth || 260, h: c?.clientHeight || 260 };
        };
        const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

        /* Where the dots pool when a seed carries no positions — mirrored from
           DEFAULT_POS in features/theme-derive.js. Spread toward the corners so
           the centre, where the toolbar and omnibox sit, stays the calm part. */
        const DEFAULT_POS = [
            [{ x: 0.30, y: 0.28 }],
            [{ x: 0.24, y: 0.22 }, { x: 0.80, y: 0.82 }],
            [{ x: 0.22, y: 0.20 }, { x: 0.82, y: 0.34 }, { x: 0.48, y: 0.86 }],
        ];
        const defaultPositions = (n) =>
            (DEFAULT_POS[Math.max(1, Math.min(3, n)) - 1] || DEFAULT_POS[0]).map(p => ({ ...p }));

        /* Make seed.positions as long as seed.colors, filling any gap from the
           defaults — so an older theme (saved before positions existed) and a
           freshly added dot both land somewhere sensible. */
        function ensurePositions() {
            const n = seed.colors.length;
            const fb = defaultPositions(n);
            const out = [];
            for (let i = 0; i < n; i++) {
                const p = seed.positions && seed.positions[i];
                out.push(p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
                    ? { x: clamp01(p.x), y: clamp01(p.y) }
                    : (fb[i] || fb[fb.length - 1] || { x: 0.5, y: 0.5 }));
            }
            seed.positions = out;
            return out;
        }

        /* The gradient the canvas shows — mirrored from gradientCss() in
           features/theme-derive.js so the editor's field is the field the
           browser will wear. Painted locally (not read off --shell-wash) so it
           is right from the instant the editor opens, before any live paint. */
        function localGradient() {
            const cols = seed.colors || [];
            // One colour is a flat ground (its hue already tints the chrome); the
            // gradient begins at two pools. Mirrors the ≥2 gate in theme-derive.js.
            if (cols.length < 2)
                return 'none';
            const inten = clamp01(seed.intensity == null ? 0.7 : seed.intensity);
            const pos = ensurePositions();
            const a = seed.mode === 'light' ? 0.40 : 0.50;
            const asRgba = (hex, al) => {
                const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
                const v = m ? parseInt(m[1], 16) : 0;
                return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${al})`;
            };
            return cols.map((hex, i) => {
                const { L, C, h } = rgbToOklch(hex);
                const lifted = toHex(oklchToRgb(L, C * (0.55 + inten * 0.75), h));
                const p = pos[i] || { x: 0.5, y: 0.5 };
                const x = (p.x * 100).toFixed(1), y = (p.y * 100).toFixed(1);
                return `radial-gradient(ellipse 85% 85% at ${x}% ${y}%, ${asRgba(lifted, a)} 0%, ${asRgba(lifted, 0)} 62%)`;
            }).join(', ');
        }

        /* Paint the canvas with the live gradient and a ground that matches what
           the chrome will sit on, so the field reads like a small browser. */
        function paintCanvas() {
            const c = el('te-canvas');
            if (!c)
                return;
            c.style.setProperty('--te-ground', groundAt(seed.level, seed.intensity));
            c.style.setProperty('--te-grad', localGradient());
        }

        /* A curated palette to pick a pool's colour from — the row you click
           instead of hunting a hue on a wheel. A spread of vivid and muted tones
           across the circle, plus the native picker at the end for anything else. */
        const PRESETS = [
            '#e5484d', '#f76808', '#f2cd37', '#46a758', '#12a594', '#0091ff',
            '#3a6ea5', '#6e56cf', '#8e4ec6', '#d6409f', '#ad7f58', '#f5c2c7',
            '#2b2f36', '#8b95a1', '#e6e1d7', '#ffffff',
        ];

        /* The same OKLab maths the main process uses, inlined: these are
           sandboxed pages and cannot require features/theme-derive.js. Only the
           wheel and the tracks need it — every colour that reaches a token
           still comes from the main process. */
        function oklchToRgb(L, C, hDeg) {
            const h = hDeg * Math.PI / 180;
            const a = Math.cos(h) * C, b = Math.sin(h) * C;
            const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
            const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
            const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
            const l = l_ ** 3, m = m_ ** 3, s2 = s_ ** 3;
            const lin = [
                +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s2,
                -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s2,
                -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s2,
            ];
            return lin.map(v => {
                const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055;
                return Math.round(Math.min(1, Math.max(0, c)) * 255);
            });
        }
        const toHex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

        /* In the Zen model a dot's position is WHERE its colour pools, not the
           colour itself — so a screen point becomes a 0..1 fraction of the
           canvas, and a stored fraction becomes a pixel offset for the dot. */
        const posToFrac = (x, y) => {
            const { w, h } = canvasSize();
            return { x: clamp01(x / (w || 1)), y: clamp01(y / (h || 1)) };
        };
        const fracToPx = (p) => {
            const { w, h } = canvasSize();
            return { x: (p?.x ?? 0.5) * w, y: (p?.y ?? 0.5) * h };
        };
        function rgbToOklch(hex) {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
            if (!m) return { L: 0, C: 0, h: 0 };
            const v = parseInt(m[1], 16);
            const to = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            const R = to((v >> 16) & 255), G = to((v >> 8) & 255), B = to(v & 255);
            const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
            const mm = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
            const s2 = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
            const a = 1.9779984951 * l - 2.4285922050 * mm + 0.4505937099 * s2;
            const b = 0.0259040371 * l + 0.7827717662 * mm - 0.8086757660 * s2;
            return {
                L: 0.2104542553 * l + 0.7936177850 * mm - 0.0040720468 * s2,
                C: Math.hypot(a, b),
                h: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360,
            };
        }

        /* Arrange snaps the pools back to their spread-out default positions —
           the "tidy this up" button for when a few drags have bunched them into
           a corner. Colours are untouched; only where they pool changes. */
        function arrange() {
            seed.positions = defaultPositions(seed.colors.length);
            renderDots();
            paintCanvas();
            schedulePreview();
        }

        /* WHICH DOT IS THE ACCENT is the one thing about this wheel you cannot
           see by looking at it, and the labels used to get it wrong: dot two
           was called "Accent" and dot three "Highlight" regardless. The ramp
           picks the MOST SATURATED of the dots that are not the ground
           (features/theme-derive.js, rolesFromColors), so dragging dot three
           further out silently made it the accent while the label still said
           otherwise. This is the same rule, read the same way. */
        function accentIndex() {
            if (seed.colors.length < 2)
                return 0;
            let best = 1;
            for (let i = 2; i < seed.colors.length; i++) {
                if (rgbToOklch(seed.colors[i]).C > rgbToOklch(seed.colors[best]).C)
                    best = i;
            }
            return best;
        }
        function roleOf(i) {
            if (seed.colors.length < 2)
                return { key: 'both', name: 'Ground and accent' };
            if (i === 0)
                return { key: 'ground', name: 'Ground' };
            return i === accentIndex()
                ? { key: 'accent', name: 'Accent' }
                : { key: 'extra', name: 'Highlight' };
        }

        function renderDots() {
            const host = el('te-dots');
            const focused = active()?.closest?.('.te-dot');
            const focusedIndex = focused ? Number(focused.dataset.i) : -1;
            /* Update in place when the count has not changed. Rebuilding threw
               away the element that had focus, so an arrow-key nudge moved a dot
               exactly once and then went nowhere — the dot a keyboard user was
               holding stopped existing between keystrokes. */
            if (host.children.length !== seed.colors.length) {
                host.textContent = '';
                seed.colors.forEach((_, i) => host.appendChild(dotEl(i)));
            }
            const pos = ensurePositions();
            seed.colors.forEach((hex, i) => {
                const d = host.children[i];
                const p = fracToPx(pos[i]);
                const role = roleOf(i);
                d.style.left = p.x + 'px';
                d.style.top = p.y + 'px';
                d.style.background = hex;
                d.classList.toggle('on', i === activeDot);
                d.dataset.role = role.key;
                d.setAttribute('aria-label', `${role.name}, ${hex}`);
                d.title = `${role.name} · ${hex}`;
            });
            if (focusedIndex >= 0 && host.children[focusedIndex])
                host.children[focusedIndex].focus({ preventScroll: true });
            renderRoles();
            renderPalette();
            syncTools();
        }

        function dotEl(i) {
            const d = document.createElement('button');
            d.type = 'button';
            d.className = 'te-dot';
            d.dataset.i = String(i);
            d.addEventListener('focus', () => setActiveDot(i));
            d.addEventListener('pointerdown', () => setActiveDot(i));
            // Arrows nudge the pool — a dot only a mouse can move is not a control.
            d.addEventListener('keydown', (e) => {
                const step = { ArrowLeft: [-0.02, 0], ArrowRight: [0.02, 0], ArrowUp: [0, -0.02], ArrowDown: [0, 0.02] }[e.key];
                if (!step) return;
                e.preventDefault();
                const p = ensurePositions()[i] || { x: 0.5, y: 0.5 };
                setDotPos(i, { x: clamp01(p.x + step[0]), y: clamp01(p.y + step[1]) });
            });
            return d;
        }

        const setActiveDot = (i) => {
            activeDot = Math.max(0, Math.min(i, seed.colors.length - 1));
            const host = el('te-dots');
            if (host)
                [...host.children].forEach((d, j) => d.classList.toggle('on', j === activeDot));
            renderRoles();
            renderPalette();
        };

        /* The roles, named, beside the tools. The wheel showed one to three
           anonymous discs and marked the accent with a ring inside it — a
           legend nobody has, for a distinction that decides what every selected
           row in the browser will look like. Naming them costs one row (shared
           with the tools) and makes the model legible: this one is the chrome,
           this one is the highlight. Clicking a chip focuses its dot, which is
           also the only pointer-free way to choose WHICH dot the arrows move. */
        function renderRoles() {
            const host = el('te-roles');
            if (!host)
                return;
            host.textContent = '';
            seed.colors.forEach((hex, i) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = 'te-chip' + (i === activeDot ? ' on' : '');
                b.dataset.i = String(i);
                const sw = document.createElement('span');
                sw.className = 'te-chip-dot';
                sw.style.background = hex;
                const label = document.createElement('span');
                label.className = 'te-chip-name';
                label.textContent = roleOf(i).name;
                b.append(sw, label);
                b.title = `${roleOf(i).name} · ${hex}`;
                b.setAttribute('aria-label', `${roleOf(i).name}, ${hex}`);
                b.addEventListener('click', () => {
                    setActiveDot(i);
                    el('te-dots')?.children[i]?.focus();
                });
                host.appendChild(b);
            });
        }

        /* The tools reflect the dot count: you cannot go below one colour
           or above three, and the buttons say so rather than failing. */
        function syncTools() {
            el('te-add').disabled = seed.colors.length >= 3;
            el('te-remove').disabled = seed.colors.length <= 1;
            el('te-scatter').disabled = seed.colors.length < 2;
        }

        /* Setting a pool's COLOUR re-derives the palette (colours are what the
           ramp reads); setting its POSITION only moves where it pools in the
           gradient — the two are separate, which is the whole point of the
           model. Both repaint the canvas and preview live. */
        function setDotColor(i, hex) {
            seed.colors[i] = hex;
            // Shade and Intensity describe the GROUND (the first colour). So
            // repicking the ground returns them to their defaults — otherwise a
            // ground you had darkened/muted for the old colour carries over and
            // the new pick doesn't look like the swatch you clicked. But an accent
            // or highlight (dots 1+) does NOT own those amounts, so recolouring
            // one must leave the ground's Shade/Intensity alone.
            if (i === 0) {
                seed.level = DEFAULT_LEVEL;
                seed.intensity = DEFAULT_INTENSITY;
            }
            setActiveDot(i);
            renderDots();
            paintCanvas();
            paintControls();
            schedulePreview();
        }
        function setDotPos(i, frac) {
            ensurePositions();
            seed.positions[i] = { x: clamp01(frac.x), y: clamp01(frac.y) };
            // Move only the one dot — a full renderDots() rebuilds the palette
            // and roles on every pointer frame, which is churn under the drag.
            const d = el('te-dots')?.children[i];
            if (d) {
                const px = fracToPx(seed.positions[i]);
                d.style.left = px.x + 'px';
                d.style.top = px.y + 'px';
            }
            paintCanvas();
            schedulePreview();
        }

        /* Pointer drag on the canvas MOVES a pool. Grabbing a dot drags it;
           pressing bare canvas picks up the active pool and drops it where you
           pressed, so a click places the selected colour. */
        (() => {
            const canvas = el('te-canvas');
            let dragging = -1;
            const at = (e) => {
                const r = canvas.getBoundingClientRect();
                return { x: e.clientX - r.left, y: e.clientY - r.top };
            };
            canvas.addEventListener('pointerdown', (e) => {
                const dot = e.target.closest('.te-dot');
                const p = at(e);
                if (dot) {
                    dragging = Number(dot.dataset.i);
                    setActiveDot(dragging);
                }
                else {
                    dragging = Math.min(activeDot, seed.colors.length - 1);
                    setDotPos(dragging, posToFrac(p.x, p.y));
                    el('te-dots')?.children[dragging]?.focus({ preventScroll: true });
                }
                canvas.setPointerCapture(e.pointerId);
            });
            canvas.addEventListener('pointermove', (e) => {
                if (dragging < 0) return;
                const p = at(e);
                setDotPos(dragging, posToFrac(p.x, p.y));
            });
            const stop = () => { dragging = -1; };
            canvas.addEventListener('pointerup', stop);
            canvas.addEventListener('pointercancel', stop);
        })();

        // Mode. Two buttons, one on.
        el('te-mode-seg').addEventListener('click', (e) => {
            const b = e.target.closest('button[data-m]');
            if (!b) return;
            setMode(b.dataset.m);
        });
        /* Arrows move within the group, the way a two-way segmented control is
           expected to: it was two ordinary buttons, so reaching Light meant
           tabbing past Dark, and neither reported that they were a pair. */
        el('te-mode-seg').addEventListener('keydown', (e) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key))
                return;
            e.preventDefault();
            setMode(seed.mode === 'dark' ? 'light' : 'dark');
            [...el('te-mode-seg').children].find(c => c.dataset.m === seed.mode)?.focus();
        });
        function setMode(m) {
            if (seed.mode === m)
                return;
            seed.mode = m;
            paintMode();
            paintControls();
            schedulePreview();
        }
        function paintMode() {
            [...el('te-mode-seg').children].forEach((c) => {
                const on = c.dataset.m === seed.mode;
                c.classList.toggle('on', on);
                c.setAttribute('aria-checked', String(on));
                c.tabIndex = on ? 0 : -1;
            });
        }

        el('te-add').addEventListener('click', () => {
            if (seed.colors.length >= 3) return;
            const { C, h } = rgbToOklch(seed.colors[0]);
            seed.colors.push(toHex(oklchToRgb(WHEEL_L, Math.max(C, 0.06), (h + 140) % 360)));
            // A new pool lands at its spread-out default slot, not on top of
            // an existing one — so the added colour is visible straight away.
            seed.positions = defaultPositions(seed.colors.length);
            setActiveDot(seed.colors.length - 1);
            renderDots(); paintCanvas(); paintControls(); schedulePreview();
        });
        el('te-remove').addEventListener('click', () => {
            if (seed.colors.length <= 1) return;
            seed.colors.pop();
            if (seed.positions) seed.positions.pop();
            setActiveDot(seed.colors.length - 1);
            renderDots(); paintCanvas(); paintControls(); schedulePreview();
        });
        el('te-scatter').addEventListener('click', arrange);

        /* ── The palette ─────────────────────────────────────────────────────
         *
         * A pool's colour is CHOSEN, not dragged for — the row of swatches sets
         * the active dot's colour, and the native picker at the end covers the
         * ones the row does not. The selected dot's own colour is marked so it
         * is clear which pool a click will recolour. */
        /* Wrap the palette in a flex row with a chevron at each end. The row
           still scrolls by wheel/drag/keys; the arrows are the visible way to do
           it and the scrollbar is hidden (see theme-editor.css). Built once,
           alongside the swatches. */
        function buildPaletteArrows(host) {
            if (!host.parentNode || host.parentNode.classList?.contains('te-palette-wrap'))
                return;
            const chevron = (d) => svg(d === -1 ? '<path d="M15 6l-6 6 6 6"/>' : '<path d="M9 6l6 6-6 6"/>');
            const mkArrow = (d) => {
                const a = document.createElement('button');
                a.type = 'button';
                a.className = 'te-pal-arrow';
                a.setAttribute('aria-label', d < 0 ? 'Scroll colours left' : 'Scroll colours right');
                a.title = d < 0 ? 'Scroll left' : 'Scroll right';
                a.tabIndex = -1;  // the swatches are the tab stops; arrows are pointer aids
                a.appendChild(chevron(d));
                a.addEventListener('click', () => host.scrollBy({ left: d * Math.max(80, host.clientWidth * 0.8), behavior: 'smooth' }));
                return a;
            };
            const wrap = document.createElement('div');
            wrap.className = 'te-palette-wrap';
            const prev = mkArrow(-1), next = mkArrow(1);
            host.parentNode.insertBefore(wrap, host);
            wrap.append(prev, host, next);
            const update = () => {
                const max = host.scrollWidth - host.clientWidth - 1;
                prev.disabled = host.scrollLeft <= 0;
                next.disabled = max <= 0 || host.scrollLeft >= max;
                // No overflow at all → nothing to scroll: no arrows (ui-polish U2-4).
                wrap.classList.toggle('no-overflow', max <= 0);
            };
            host.addEventListener('scroll', update, { passive: true });
            window.addEventListener('resize', update);
            // Measured after layout so the initial disabled state is correct.
            requestAnimationFrame(update);
        }

        function renderPalette() {
            const host = el('te-palette');
            if (!host)
                return;
            const activeHex = (seed.colors[activeDot] || '').toLowerCase();
            // Build the fixed swatch row once; only the selected mark changes after.
            if (!host.dataset.built) {
                host.dataset.built = '1';
                for (const hex of PRESETS) {
                    const b = document.createElement('button');
                    b.type = 'button';
                    b.className = 'te-sw';
                    b.dataset.hex = hex.toLowerCase();
                    b.style.background = hex;
                    b.title = hex;
                    b.setAttribute('aria-label', `Set the selected colour to ${hex}`);
                    b.addEventListener('click', () => setDotColor(activeDot, hex.toLowerCase()));
                    host.appendChild(b);
                }
                const pick = document.createElement('label');
                pick.className = 'te-sw te-sw-custom';
                pick.title = 'Custom colour';
                pick.setAttribute('aria-label', 'Custom colour');
                const input = document.createElement('input');
                input.type = 'color';
                input.id = 'te-color-input';
                input.addEventListener('input', (e) => setDotColor(activeDot, e.target.value.toLowerCase()));
                pick.appendChild(input);
                host.appendChild(pick);
                buildPaletteArrows(host);
            }
            for (const b of host.querySelectorAll('.te-sw'))
                b.classList.toggle('on', b.dataset.hex === activeHex);
            const input = el('te-color-input');
            if (input)
                input.value = /^#[0-9a-f]{6}$/.test(activeHex) ? activeHex : '#000000';
        }

        /* ── The three amounts ───────────────────────────────────────────────
         *
         * Shade, Intensity and Grain were a bespoke 58px dial with a bare
         * number in it and an unlabelled slider whose track was invisible. Two
         * controls, no names, no units, and one of them — the dial — had a
         * drag mapping (a 280° sweep starting at -140°) that nothing on screen
         * explained. Neither said what it did.
         *
         * They are now one anatomy repeated three times: name, track, value.
         * The track of each IS its own quantity — Shade runs through the actual
         * grounds you are choosing between, Intensity from neutral to the
         * fullest tint that survives the chroma ceiling, Grain draws the
         * texture as a wave that flattens at nothing and chops at full. A
         * control that renders its own range needs no legend, and it makes the
         * ceiling visible rather than hidden: past the point where the ground's
         * chroma is capped the Intensity track stops changing, which is the
         * truth about what that end of the slider does.
         *
         * All three are real <input type="range">, so they are keyboard-native
         * — the dial was a <div role="presentation"> with a visually hidden
         * range beside it doing the actual work.
         */
        const bandFor = mode => GROUND_L[mode === 'light' ? 'light' : 'dark'];

        /* The ground a given level and intensity produce — the same expression
           as rolesFromColors + the ground chroma cap in features/theme-derive.js. */
        function groundAt(level, intensity) {
            const [lo, hi] = bandFor(seed.mode);
            const { C, h } = rgbToOklch(seed.colors[0] || '#888888');
            return toHex(oklchToRgb(
                lo + (hi - lo) * clamp01(level),
                Math.min(C * clamp01(intensity), GROUND_C_MAX),
                h));
        }
        const rampCss = (at) => 'linear-gradient(90deg,' +
            [0, 0.25, 0.5, 0.75, 1].map(t => `${at(t)} ${t * 100}%`).join(',') + ')';

        function bindRange(id, key, onPaint) {
            el(id).addEventListener('input', (e) => {
                seed[key] = Number(e.target.value) / 100;
                onPaint();
                paintControls();
                schedulePreview();
            });
        }
        bindRange('te-shade', 'level', () => {});
        bindRange('te-intensity', 'intensity', () => {});
        bindRange('te-grain', 'grain', () => {});

        /* Words, not raw numbers (ui-polish U2-4): each slider gets its two
           ends spelled out under the track, the number shows only while you
           adjust it, and screen readers hear "36 — Darker to Lighter". Built
           here so both copies of the markup (Settings, Theme panel) get it. */
        const ENDS = {
            'te-shade': ['Darker', 'Lighter'],
            'te-intensity': ['Muted', 'Vivid'],
            'te-grain': ['Smooth', 'Textured'],
        };
        const valueText = (id) => {
            const input = el(id);
            const [lo, hi] = ENDS[id];
            return input ? `${input.value} — ${lo} to ${hi}` : '';
        };
        for (const id of Object.keys(ENDS)) {
            const input = el(id);
            const ctl = input?.closest('.te-ctl');
            if (!ctl || ctl.querySelector('.te-ends'))
                continue;
            const ends = document.createElement('span');
            ends.className = 'te-ends';
            ends.setAttribute('aria-hidden', 'true');
            for (const word of ENDS[id]) {
                const w = document.createElement('span');
                w.textContent = word;
                ends.appendChild(w);
            }
            ctl.appendChild(ends);
            input.setAttribute('aria-valuetext', valueText(id));
            let quiet = null;
            const adjusting = (on) => {
                clearTimeout(quiet);
                if (on) ctl.classList.add('adjusting');
                else quiet = setTimeout(() => ctl.classList.remove('adjusting'), 700);
            };
            input.addEventListener('pointerdown', () => adjusting(true));
            input.addEventListener('keydown', () => adjusting(true));
            input.addEventListener('input', () => { adjusting(true); input.setAttribute('aria-valuetext', valueText(id)); adjusting(false); });
            input.addEventListener('pointerup', () => adjusting(false));
            input.addEventListener('blur', () => adjusting(false));
        }
        {
            const canvas = el('te-canvas');
            if (canvas && !canvas.parentNode.querySelector('.te-caption')) {
                const cap = document.createElement('p');
                cap.className = 'te-caption';
                cap.textContent = 'Drag to pick the ground colour';
                canvas.insertAdjacentElement('afterend', cap);
                const hint = document.createElement('div');
                hint.className = 'te-hint';
                hint.setAttribute('aria-hidden', 'true');
                hint.textContent = 'Drag a dot to move its colour';
                canvas.appendChild(hint);
                const done = () => { hint.classList.add('gone'); canvas.removeEventListener('pointerdown', done); };
                canvas.addEventListener('pointerdown', done);
            }
        }

        function paintControls() {
            const set = (id, v) => {
                const input = el(id);
                if (!input) return;
                input.value = String(Math.round(clamp01(v) * 100));
                const out = el(id + '-val');
                if (out) out.textContent = String(Math.round(clamp01(v) * 100));
            };
            set('te-shade', seed.level);
            set('te-intensity', seed.intensity);
            set('te-grain', seed.grain);
            for (const id of ['te-shade', 'te-intensity', 'te-grain']) {
                const input = el(id);
                if (input && input.hasAttribute('aria-valuetext'))
                    input.setAttribute('aria-valuetext', valueText(id));
            }
            const shade = el('te-shade-track');
            if (shade)
                shade.style.background = rampCss(t => groundAt(t, seed.intensity));
            const chroma = el('te-intensity-track');
            if (chroma)
                chroma.style.background = rampCss(t => groundAt(seed.level, t));
            paintWave();
            // Shade and Intensity both change the field, so keep it in step.
            paintCanvas();
        }

        /* The wave IS the value. It used to be a fixed squiggle — flat at one
           end, choppy at the other — that never moved, so it decorated the
           track rather than reporting it, and switching themes left it showing
           the last theme's texture. Amplitude now follows the grain: none is a
           straight line, full is a hard chop. */
        function paintWave() {
            const art = root.querySelector('.te-wave-art path');
            if (!art)
                return;
            const amp = 9 * clamp01(seed.grain);
            const W = 240, MID = 12, STEP = 8;
            let d = `M0 ${MID}`;
            for (let x = STEP; x <= W; x += STEP) {
                const dir = (x / STEP) % 2 ? -1 : 1;
                d += ` Q${(x - STEP / 2).toFixed(1)} ${(MID + dir * amp).toFixed(1)} ${x} ${MID}`;
            }
            art.setAttribute('d', d);
        }

        /* Every change goes STRAIGHT to the browser. There is no Save: a theme is
           a thing you look at, and a colour picker whose result only appears
           after you commit is one you have to guess at. Editing a theme of your
           own writes through to it; touching a built-in forks it into one of
           yours on the first change, because a built-in is not yours to alter
           and refusing to move would be the wrong answer to a dragged dot. */
        let commitTimer = null;
        let committing = false;

        /* A change paints IMMEDIATELY and saves LATER.
           The paint is inline custom properties on every surface of this window
           (see previewLive in features/theme-runtime.js) — same frame, no
           stylesheet swap, no disk. The save is the real thing, and it waits
           for you to stop moving. Saving on every frame was a stylesheet swap
           and a disk write per pointer move, which is what made the whole UI
           strobe while you dragged. */
        const schedulePreview = () => {
            try { T.live?.(seed); }
            catch (e) { /* the save below is still the source of truth */ }
            clearTimeout(commitTimer);
            commitTimer = setTimeout(commit, 260);
        };

        /* An unusable palette used to fail in SILENCE. `theme-live` refuses to
           paint one and `commit` returned before saving, so dragging into a
           region the contrast floors reject looked exactly like dragging into a
           region that had stopped responding — same wheel, same dot, nothing
           moving. The floors are worth keeping; not saying so is not. */
        function warn(message) {
            const w = el('te-warn');
            if (!w)
                return;
            w.textContent = message || '';
            w.hidden = !message;
        }

        async function commit() {
            if (committing)
                return;
            const res = await T.preview(seed);
            if (!res?.ok) {
                warn(res?.errors?.[0] ? `Not saved: ${res.errors[0]}.` : 'Not saved: this palette cannot be read.');
                return;  // unusable palette: leave the browser on the last good one
            }
            warn('');
            committing = true;
            try {
                /* Every edit writes to THIS scope's one slot, in place. No new
                   theme is minted and nothing accumulates — the space keeps a
                   single editable gradient (Zen/Arc's model). The name is
                   internal (never shown), derived once from the first colour. */
                const saved = await T.save({ id: slotId, name: nameFor(seed), seed });
                if (!saved?.ok)
                    return;
                if (current !== saved.theme.id) {
                    current = saved.theme.id;
                    markCurrent();
                    await ctx.setTheme(current);
                }
            }
            finally {
                committing = false;
            }
        }

        /* The slot needs a name for storage, but it is never shown — there is no
           library and no caption any more. Name it for the first colour's hue so
           the stored record is legible if ever inspected. */
        const HUES = [
            [15, 'Red'], [45, 'Amber'], [75, 'Olive'], [110, 'Green'], [160, 'Teal'],
            [200, 'Cyan'], [240, 'Blue'], [280, 'Indigo'], [320, 'Violet'], [350, 'Pink'], [361, 'Red'],
        ];
        function nameFor(s) {
            const first = (s.colors || [])[0];
            const { C, h } = rgbToOklch(first || '#888888');
            return C < 0.02
                ? (s.mode === 'light' ? 'Paper' : 'Graphite')
                : (HUES.find(([max]) => h < max) || HUES[HUES.length - 1])[1];
        }

        /* Load a SEED into the editor. The scope's theme is edited in place, so
           there is no "which custom theme" to track — just the working seed, and
           every commit writes it to this scope's slot. A null seed (a scope never
           themed, or a preset with no dots) starts from a sensible default. */
        function openEditor(src) {
            const colors = (src?.colors || ['#3a6ea5']).slice(0, 3);
            seed = src && Array.isArray(src.colors) && src.colors.length
                ? { mode: src.mode || 'dark',
                    colors,
                    positions: (Array.isArray(src.positions) ? src.positions : []).slice(0, colors.length),
                    intensity: src.intensity == null ? 0.7 : src.intensity,
                    grain: src.grain || 0,
                    level: src.level == null ? DEFAULT_LEVEL : src.level }
                : { mode: 'dark', colors: ['#3a6ea5'], positions: [], intensity: 0.7, grain: 0, level: DEFAULT_LEVEL };
            ensurePositions();
            activeDot = 0;
            warn('');
            paintMode();
            editor.hidden = false;
            renderDots();
            paintCanvas();
            paintControls();
            /* Focus the field itself, not a control below it. */
            el('te-dots')?.firstElementChild?.focus({ preventScroll: true });
            /* NO commit and no live paint on open: opening the editor is not an
               edit, and the browser is already wearing what the canvas shows. */
        }

        /* In the Settings page the editor is a section; in the popup it IS the
           panel, so Done is handed to the host to dismiss the panel. */
        const closeEditor = () => {
            if (ctx.alwaysOpen) {
                ctx.onCancel?.();
                return;
            }
            editor.hidden = true;
        };
        el('te-cancel')?.addEventListener('click', closeEditor);

        // A radiogroup is one tab stop; arrows move within the preset circles.
        picker?.addEventListener('keydown', (e) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
            if (!step)
                return;
            const opts = [...picker.querySelectorAll('.theme-preset')];
            if (!opts.length)
                return;
            e.preventDefault();
            const from = opts.indexOf(active());
            const i = from >= 0 ? from : opts.findIndex(o => o.getAttribute('aria-checked') === 'true');
            const next = opts[(i + step + opts.length) % opts.length];
            next.focus();
            const t = presets.find(p => p.id === next.dataset.themeValue);
            if (t) choosePreset(t);
        });

        T.onChanged?.(() => refresh());
        refresh().then(() => {
            /* Open straight into the editor on THIS scope's current theme: its
               own edited gradient if it has one (the slot), else the preset it is
               wearing, ready for the first edit to fork from. */
            const slot = list.find(x => x.id === slotId);
            const cur = list.find(x => x.id === current);
            const startSeed = (current === slotId && slot)
                ? slot.seed
                : (cur?.seed || cur?.wheelSeed || slot?.seed || null);
            openEditor(startSeed);
        });
        return { refresh, openEditor };
    }

    window.Northstar.themeEditor = { mount };
})();
