/**
 * The theme registry — built-ins, user themes, and the one lookup everything
 * else uses.
 *
 * Two kinds of theme live here and they are NOT the same shape:
 *
 *   CSS-backed  the original four. Their tokens are written out by hand in
 *               renderer/styles/{ui,themes}.css under html[data-theme="<id>"],
 *               they are what the design was tuned against, and nothing here
 *               re-derives them. Setting one is still just an attribute.
 *   Derived     everything else — the newer grounds below and every theme a
 *               user makes. These have no CSS anywhere, so their tokens are
 *               produced by features/theme-derive.js and injected at runtime
 *               (see themeCss / ipc/settings.js).
 *
 * The split is deliberate. Re-deriving the original four would move them:
 * Slate's --page comes out #131314 rather than the #121213 that shipped. Close
 * enough to prove the ramp is right, not close enough to change under someone
 * who chose it.
 *
 * A user theme is three or four decisions (mode, ground, accent, optional ink)
 * — never sixteen hex values. That is what keeps a theme somebody invents from
 * having the elevation upside down or unreadable body text.
 */
const {
    derive, toCss, validate, toLch, fromLch, groundLevelFor,
    WHEEL_L, DEFAULT_LEVEL, GROUND_CHROMA_MAX,
} = require('./theme-derive');
const log = require('./log');

/* The accent does not change with the ground. themes.css: "The ground is what
   a theme is; the identity colour does not change with it." User themes may
   choose their own — it is their browser — but a built-in that shipped with a
   different accent would just be a different product. */
const IDENTITY_ACCENT = '#e5484d';

/* `swatch` is what the Settings picker paints its miniature from. The four
   CSS-backed themes keep their values here because the only other copy is in a
   stylesheet the main process does not parse; derived themes get theirs from
   the ramp. Five colours, read off renderer/styles/themes.css. */
const CSS_BACKED = [
    { id: 'default',   name: 'Slate',     mode: 'dark',  icon: { field: '#0a0a0b', mark: '#fafafa' },
      swatch: { shell: '#0a0a0b', page: '#121213', bg: '#050506', text: '#fafafa', accent: '#e5484d', ownAccent: false } },
];

/** The five colours a picker miniature needs, from a full token set. */
function swatchOf(tokens) {
    return {
        shell: tokens['--shell'], page: tokens['--page'], bg: tokens['--bg'],
        text: tokens['--text'], accent: tokens['--accent'],
        ownAccent: !sameHex(tokens['--accent'], IDENTITY_ACCENT),
    };
}
/* Does this theme carry an accent of its own, or the house one? The picker
   badges only the ones that do. Every built-in but Blocks shares IDENTITY_ACCENT
   by design, so badging all of them drew six identical red dots that said
   nothing — and a small red disc on the shoulder of a swatch reads as an error
   marker, not as a colour. */
function sameHex(a, b) {
    const n = (h) => {
        const v = String(h || '').trim().replace('#', '').toLowerCase();
        return v.length === 3 ? v.split('').map(c => c + c).join('') : v;
    };
    return n(a) === n(b);
}

/* Derived grounds. Each is one colour plus a mode; the ramp does the rest.
   They are meant to disappear behind the page — a browser chrome is furniture,
   and a theme you notice on the second day is a theme you turn off.
   Blocks is the exception, and says so. */
const DERIVED = [
    { id: 'fog',     name: 'Fog',     seed: { mode: 'light', base: '#e4e9ee', accent: IDENTITY_ACCENT, ink: '#16202b' } },
    { id: 'harbour', name: 'Harbour', seed: { mode: 'dark',  base: '#141b23', accent: IDENTITY_ACCENT } },
    { id: 'clay',    name: 'Clay',    seed: { mode: 'light', base: '#efeae2', accent: IDENTITY_ACCENT, ink: '#2b2419' } },
    { id: 'dusk',    name: 'Dusk',    seed: { mode: 'dark',  base: '#17151d', accent: IDENTITY_ACCENT } },
    /* Blocks. Primary-colour plastic — the one theme here that is not trying to
       get out of the way. It needs `vivid` because the ordinary chroma cap
       exists precisely to stop a ground looking like this; validate() still
       holds the contrast line, so it is loud, not unreadable. Ground and accent
       are the real moulded colours, not approximations of them. */
    { id: 'blocks',  name: 'Blocks',  seed: { mode: 'dark', base: '#0055bf', accent: '#f2cd37', vivid: true } },
    /* Gradient presets — the Zen model, as starting points. Each is a set of
       COLOURS the chrome pools into a gradient (positions default to the spread
       in theme-derive.js). Tapping one in the editor applies it; the first edit
       forks it into the space's own editable gradient. They validate the same
       way every theme does, so they are vivid, not unreadable. */
    { id: 'aurora',  name: 'Aurora',  seed: { mode: 'dark',  colors: ['#12a594', '#0091ff', '#6e56cf'], intensity: 0.85, grain: 0.12 } },
    { id: 'sunset',  name: 'Sunset',  seed: { mode: 'dark',  colors: ['#f76808', '#d6409f', '#6e56cf'], intensity: 0.85, grain: 0.12 } },
    { id: 'ember',   name: 'Ember',   seed: { mode: 'dark',  colors: ['#e5484d', '#f76808', '#f2cd37'], intensity: 0.85, grain: 0.12 } },
    { id: 'meadow',  name: 'Meadow',  seed: { mode: 'light', colors: ['#46a758', '#12a594', '#f2cd37'], intensity: 0.8,  grain: 0.10 } },
    { id: 'orchid',  name: 'Orchid',  seed: { mode: 'light', colors: ['#8e4ec6', '#d6409f', '#0091ff'], intensity: 0.8,  grain: 0.10 } },
];

const CUSTOM_PREFIX = 'custom:';
const isCustom = id => String(id || '').startsWith(CUSTOM_PREFIX);

let readCustoms = () => [];

/** Point the registry at persistence. Called once from window-manager/main. */
function bind(persistence) {
    readCustoms = () => {
        try {
            const list = persistence?.get('customThemes');
            return Array.isArray(list) ? list : [];
        }
        catch (e) {
            log.warn('themes', 'reading customThemes', e);
            return [];
        }
    };
}

/* The wheel's own limit, mirrored from MAX_C in renderer/lib/theme-editor.js:
   beyond it sRGB clips anyway, so a dot cannot be placed further out. */
const WHEEL_MAX_C = 0.16;

/**
 * The seed a NEW theme starts from when it is forked off `t`.
 *
 * "New theme" copies the theme you are wearing, so every theme — including a
 * built-in, which has no wheel seed of its own — has to be expressible as dots.
 * It used to be read straight off the swatch (`shell` as dot one), which was
 * not a copy of anything: the ramp then re-derived a ground from that dot's own
 * lightness and chroma, so a fork of Harbour came out at L 0.11 against
 * Harbour's 0.22 — a different theme, two elevation steps darker.
 *
 * So the seed is SOLVED backwards instead: place the dot at the wheel's own
 * lightness (where the wheel will keep it), give it the hue and the chroma that
 * survive intensity, and record the ground's level. What the wheel then draws
 * is what the browser is already wearing, and the first drag moves it from
 * there rather than jumping.
 *
 * Three things a wheel seed cannot hold, and does not pretend to: a `vivid`
 * ground (the chroma cap is what stops a user theme shouting over its own
 * accent), an accent lighter or darker than the wheel's slice, and a hand-set
 * ink. A fork of Blocks is Blocks' hue at the quiet ceiling, not Blocks.
 */
function wheelSeedFor(t) {
    if (t?.seed && Array.isArray(t.seed.colors))
        return t.seed;                       // a user theme already IS dots
    const mode = t?.mode === 'light' ? 'light' : 'dark';
    const ground = toLch(t?.swatch?.shell) || { L: mode === 'light' ? 0.93 : 0.18, C: 0, h: 0 };
    const target = toLch(t?.swatch?.accent);
    const dot = (C, h) => fromLch({ L: WHEEL_L, C: Math.min(WHEEL_MAX_C, Math.max(0, C)), h });
    const level = groundLevelFor(mode, ground.L);
    const groundC = Math.min(ground.C, GROUND_CHROMA_MAX);
    /* The ground comes out the same at any intensity — the dot carries
       `groundC / intensity` and the ramp multiplies it straight back — so
       intensity is free to be chosen for what it does to the ACCENT. */
    const attempt = (intensity, extra) => {
        const seed = { mode, colors: [dot(groundC / intensity, ground.h)], intensity, grain: 0, level };
        if (extra)
            seed.colors.push(dot(extra.C, extra.h));
        return seed;
    };
    /* ONE dot is a truer copy than two whenever it already lands on the accent.
       A ground under 0.02 chroma has no hue worth boosting, so the ramp gives
       it the house accent — which is exactly what every built-in but Blocks
       wears. Adding a second dot there would replace an exact match with an
       approximation, because a dot's lightness is pinned to the wheel's slice
       and the house accent does not sit on it.
       Rather than special-case that, ask the question directly, at the house
       intensity first and then at full — full pushes the same ground chroma
       into a smaller dot, which is what tips a theme like Harbour under the
       line and buys back its exact red. */
    for (const intensity of [0.7, 1]) {
        const seed = attempt(intensity, null);
        if (!target || accentMatches(seed, target))
            return seed;
    }
    return attempt(0.7, target);
}

/** Does `seed` already derive an accent indistinguishable from `want`? */
function accentMatches(seed, want) {
    const got = toLch(derive(seed).tokens['--accent']);
    if (!got)
        return false;
    // Shortest way round the wheel: 0 is the same hue, 180 is opposite.
    const dh = Math.abs(((got.h - want.h + 540) % 360) - 180);
    // A near-neutral has no hue worth comparing — atan2 on ~0 chroma is noise.
    const hueMatters = got.C > 0.02 && want.C > 0.02;
    return Math.abs(got.L - want.L) < 0.06
        && Math.abs(got.C - want.C) < 0.04
        && (!hueMatters || dh < 8);
}

/** Every theme, in the order the picker should show them. */
function all() {
    const withFork = t => ({ ...t, wheelSeed: wheelSeedFor(t) });
    const derived = (t, kind) => {
        const d = derive(t.seed);
        return withFork({ id: t.id, name: t.name, mode: d.mode, kind, swatch: swatchOf(d.tokens), seed: t.seed });
    };
    return [
        ...CSS_BACKED.map(t => withFork({ id: t.id, name: t.name, mode: t.mode, kind: 'builtin', swatch: t.swatch })),
        ...DERIVED.map(t => derived(t, 'builtin')),
        ...readCustoms().filter(t => t && t.seed).map(t => derived(t, 'custom')),
    ];
}

/**
 * Resolve an id to everything the rest of the app needs:
 *   { id, name, mode, tokens, css, icon }
 * `tokens`/`css` are null for a CSS-backed theme — there is nothing to inject.
 * An unknown id falls back to the default rather than leaving a window
 * unthemed, which is what a deleted custom theme used to do.
 */
function resolve(id) {
    const builtin = CSS_BACKED.find(t => t.id === id);
    if (builtin)
        return { ...builtin, tokens: null, css: null, kind: 'builtin' };

    const derived = DERIVED.find(t => t.id === id);
    if (derived) {
        const d = derive(derived.seed);
        return {
            id: derived.id, name: derived.name, mode: d.mode, kind: 'builtin',
            tokens: d.tokens, css: toCss(d.tokens, `html[data-theme="${derived.id}"]`, d.mode), icon: d.icon,
        };
    }

    if (isCustom(id)) {
        const custom = readCustoms().find(t => t.id === id);
        if (custom && custom.seed) {
            const d = derive(custom.seed);
            return {
                id: custom.id, name: custom.name || 'Custom', mode: d.mode, kind: 'custom',
                tokens: d.tokens, css: toCss(d.tokens, `html[data-theme="${cssEscape(custom.id)}"]`, d.mode), icon: d.icon,
            };
        }
    }
    return resolve('default');
}

/** `mode` decides nativeTheme.themeSource — it was a hardcoded id list. */
function modeOf(id) {
    return resolve(id).mode;
}

/**
 * The colour a page card sits on for `id`.
 *
 * Native page views paint their own background before the site does, and that
 * was a hardcoded white — a white flash behind every load, on every theme,
 * which on a dark ground is the most visible thing the browser does.
 */
function pageColorOf(id) {
    const t = resolve(id);
    return t.tokens?.['--page'] || t.swatch?.page || '#121213';
}

/** The CSS to inject for `id`, or '' when the stylesheets already carry it. */
function themeCss(id) {
    return resolve(id).css || '';
}

/* An id lands inside an attribute selector, so it has to survive being one. */
function cssEscape(id) {
    return String(id).replace(/["\\]/g, '\\$&');
}

/** Validate + normalise a user theme before it is stored. */
function prepareCustom(input, existingId = null) {
    const name = String(input?.name || '').trim().slice(0, 40);
    const src = input?.seed || {};
    /* A user theme is dots on a wheel: mode, up to three colours, and two
       sliders. Nothing else is accepted from the renderer — the roles (ground,
       accent, ink) are DERIVED, so a saved theme cannot carry a hand-set token
       that the ramp would then contradict. */
    const clamp = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;
    };
    const colors = (Array.isArray(src.colors) ? src.colors : [])
        .filter(c => /^#[0-9a-fA-F]{6}$/.test(String(c || '').trim()))
        .slice(0, 3)
        .map(c => String(c).trim().toLowerCase());
    const seed = {
        mode: src.mode === 'light' ? 'light' : 'dark',
        colors,
        /* Where each colour POOLS in the gradient, 0..1 in the editor canvas,
           parallel to colors. This is the Zen model: position is layout, not
           hue. Kept only as far as there are colours, and each entry clamped —
           a saved theme cannot carry a pool off the canvas. */
        positions: (Array.isArray(src.positions) ? src.positions : [])
            .slice(0, colors.length)
            .map(p => ({ x: clamp(p && p.x, 0.5), y: clamp(p && p.y, 0.5) })),
        intensity: clamp(src.intensity, 0.7),
        grain: clamp(src.grain, 0),
        /* How dark the ground sits, 0..1 across the mode's band. Stored rather
           than inferred so a theme forked off a built-in keeps that built-in's
           depth — see wheelSeedFor. */
        level: clamp(src.level, DEFAULT_LEVEL),
    };

    const errors = [];
    if (!name)
        errors.push('a theme needs a name');
    const v = validate(seed);
    if (!v.ok)
        errors.push(...v.errors);
    if (errors.length)
        return { ok: false, errors };

    return {
        ok: true,
        theme: {
            id: existingId || `${CUSTOM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
            name, seed,
        },
        contrast: v.contrast,
    };
}

module.exports = {
    bind, all, resolve, modeOf, themeCss, pageColorOf, prepareCustom, swatchOf,
    wheelSeedFor, isCustom, CSS_BACKED, DERIVED, IDENTITY_ACCENT,
};
