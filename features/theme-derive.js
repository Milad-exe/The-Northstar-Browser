/**
 * A theme from three decisions.
 *
 * renderer/styles/themes.css states the rule the four built-in grounds follow:
 * "Every ground is built the same way — a deep, near-neutral shell, a page a
 * step above it, wells a step below — and the accent is the only saturated
 * thing on screen." That rule was previously carried by hand, sixteen hex
 * values at a time, which is fine for four themes and impossible for a theme
 * the user invents. This module IS the rule: give it a ground, an accent and a
 * mode, and it produces the whole token set with the elevation running the
 * right way.
 *
 * Everything happens in OKLCH, not HSL. HSL's lightness is not perceptual —
 * #0000ff and #ffff00 are both "50% light" in HSL and nowhere near it on
 * screen — so an HSL ramp bunches up in the blues and washes out in the
 * yellows, and a user-picked ground would land somewhere different in tone for
 * every hue. OKLCH steps look like even steps to the eye at any hue, which is
 * the whole point of deriving a ramp rather than picking one.
 *
 * Pure, dependency-free, and required by tests/unit.js — no Electron here.
 */

/* ── sRGB ⇄ OKLab ─────────────────────────────────────────────────────────── */

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const srgbToLinear = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
const linearToSrgb = c => c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;

function hexToRgb(hex) {
    let h = String(hex || '').trim().replace(/^#/, '');
    if (h.length === 3)
        h = h.split('').map(c => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h))
        return null;
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

function rgbToHex([r, g, b]) {
    const to = v => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
    return '#' + to(r) + to(g) + to(b);
}

function rgbToOklab([r, g, b]) {
    const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    ];
}

function oklabToRgb([L, a, b]) {
    const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
    const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
    const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
    return [
        linearToSrgb(+4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
    ];
}

/** hex → {L, C, h} with L in 0..1, C in 0..~0.4, h in degrees. */
function toLch(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb)
        return null;
    const [L, a, b] = rgbToOklab(rgb);
    return { L, C: Math.hypot(a, b), h: (Math.atan2(b, a) * 180 / Math.PI + 360) % 360 };
}

/** {L, C, h} → hex, gamut-mapped by pulling chroma in until it fits sRGB. */
function fromLch({ L, C, h }) {
    const rad = h * Math.PI / 180;
    let c = Math.max(0, C);
    for (let i = 0; i < 24; i++) {
        const rgb = oklabToRgb([L, Math.cos(rad) * c, Math.sin(rad) * c]);
        if (rgb.every(v => v >= -0.0005 && v <= 1.0005))
            return rgbToHex(rgb);
        c *= 0.88; // desaturate rather than clip — clipping shifts the hue
    }
    return rgbToHex(oklabToRgb([L, 0, 0]));
}

/** Relative luminance (WCAG), for contrast checks. */
function luminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb)
        return 0;
    const [R, G, B] = rgb.map(srgbToLinear);
    return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

/** WCAG contrast ratio between two hex colours (1..21). */
function contrast(a, b) {
    const la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ── The ramp ─────────────────────────────────────────────────────────────── */

/* The ramp is OFFSETS from the ground the user picked, not absolute stops.
   Absolute stops made every dark theme the same dark: pick #0a0a0b and the
   shell came back #161617, which is not the colour anyone chose. The ground
   sets the level; the ramp only says how far apart the layers sit.

   Direction, from renderer/styles/themes.css: a recessed well (--bg) sits
   BELOW the shell, the page above it, cards above that. In a light theme the
   page is already at white, so elevation runs the other way numerically and
   --surface steps slightly down from --page — which is what Porcelain does.

   L0 is clamped to a window per mode: outside it there is no room left for
   five distinguishable layers plus readable text, and a "theme" that is five
   shades of the same black is not one. */
const L_WINDOW = { dark: [0.06, 0.42], light: [0.80, 0.99] };
const RAMP = {
    dark:  { bg: -0.030, shell: 0, page: +0.040, surface: +0.085, surface2: +0.125 },
    light: { bg: -0.050, shell: 0, page: +0.045, surface: +0.032, surface2: +0.016 },
};
/* Depth — the second axis, so the chrome is more than a monochrome lightness
   ramp. Each layer carries not just its own lightness but a little more chroma
   and a small hue drift as it rises (a recessed well cooler and greyer, a raised
   card warmer and a touch richer) — the way real surfaces shift under light.
   `dh` is degrees of OKLCH hue drift, `cMul` scales the ground chroma; both are
   multiplied by the seed's `depth` (0 = the old flat ramp, exactly; 1 = full),
   so every theme derived before this is unchanged at depth 0. The magnitudes are
   deliberately small — the accent must stay the loudest colour on screen. */
const DEPTH = {
    dark: {
        bg:       { dh: -4, cMul: 0.60 },
        shell:    { dh:  0, cMul: 1.00 },
        page:     { dh: +2, cMul: 1.15 },
        surface:  { dh: +4, cMul: 1.40 },
        surface2: { dh: +6, cMul: 1.70 },
    },
    light: {
        bg:       { dh: -4, cMul: 0.60 },
        shell:    { dh:  0, cMul: 1.00 },
        page:     { dh: +2, cMul: 1.15 },
        surface:  { dh: +4, cMul: 1.35 },
        surface2: { dh: +6, cMul: 1.50 },
    },
};
const DEPTH_DEFAULT = 0.55;
/* Text lightness is absolute — it is the one thing that must not follow the
   ground, because it is what has to stay legible on it. */
const TEXT_L = {
    dark:  { text: 0.97, text2: 0.72, text3: 0.60 },
    light: { text: 0.22, text2: 0.46, text3: 0.56 },
};

/* A ground carries its hue, never a wash of it: the accent has to stay the only
   saturated thing on screen. The cap sits above every ground that ships —
   Slate 0.002, Porcelain 0.004, Fathom 0.023, Dune 0.039, private violet
   0.055 — so a real pick passes through untouched and --shell is exactly the
   colour that was chosen. It bites only on a genuinely garish one, and then it
   desaturates rather than refuses: a fire-engine-red chrome leaves the accent
   nowhere to be the loudest thing on screen. An accent runs ~0.19, an order of
   magnitude up, which is the gap this cap exists to protect. */
const GROUND_CHROMA_MAX = 0.060;
/* `vivid` is the deliberate exception. The caps above exist so a ground cannot
   shout over the accent, which is right for every theme meant to disappear
   behind the page — and wrong for one whose entire point is that it does not.
   A vivid theme gets a far higher chroma ceiling and a wider lightness window;
   validate() still refuses it if the result cannot be read, so this loosens
   taste, never legibility. */
const VIVID_CHROMA_MAX = 0.190;
const VIVID_L_WINDOW = { dark: [0.04, 0.55], light: [0.68, 0.99] };
const TEXT_CHROMA_MAX = 0.014;
/* An explicit ink is allowed far more chroma than a derived one: "navy ink on
   cream" is a whole theme's identity (Dune), and capping it at the ground's
   0.014 turned it into grey-on-cream — the same theme with the character taken
   out. Derived ink stays near-neutral; chosen ink is honoured. */
const INK_CHROMA_MAX = 0.075;

const round = (n, p = 3) => Number(n.toFixed(p));

/** hex → `rgba(r,g,b,a)`, for gradient stops that must sit over the shell. */
function rgba(hex, alpha) {
    const c = hexToRgb(hex) || [0, 0, 0];
    return `rgba(${c.map(v => Math.round(clamp01(v) * 255)).join(',')},${alpha})`;
}

/* ── The gradient the browser wears ──────────────────────────────────────────
 *
 * A theme's colours are placed as POOLS on a canvas — the Zen model — and the
 * chrome wears the blend of them over --shell. Each dot is a soft radial pool
 * at its own position; stacked, they melt into one another. Position is layout
 * (where the colour pools), which is a separate thing from the colour itself —
 * unlike the old wheel, where a dot's position WAS its hue.
 *
 * The alpha is deliberately short of opaque: the wash sits UNDER the sidebar's
 * own text, and body text is checked on --page (the card), never on the washed
 * shell, so a pool strong enough to drown a label would pass validate() and
 * still be wrong. These values keep the gradient plainly visible while leaving
 * the chrome legible; the pools also fade to nothing by 62%, so the centre —
 * where the omnibox and toolbar sit — stays the quietest part of the field. */
const GRAD_ALPHA = { dark: 0.50, light: 0.40 };
/* Where the dots sit when a seed carries none (older themes, and the first
   frame of a fork). Spread toward the corners so the centre stays calm. */
const DEFAULT_POS = [
    [{ x: 0.30, y: 0.28 }],
    [{ x: 0.24, y: 0.22 }, { x: 0.80, y: 0.82 }],
    [{ x: 0.22, y: 0.20 }, { x: 0.82, y: 0.34 }, { x: 0.48, y: 0.86 }],
];
function positionsFor(colors, positions) {
    const n = Math.max(1, Math.min(3, (colors || []).length));
    const fallback = DEFAULT_POS[n - 1] || DEFAULT_POS[0];
    return (colors || []).map((_, i) => {
        const p = positions && positions[i];
        return (p && Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y)))
            ? { x: clamp01(Number(p.x)), y: clamp01(Number(p.y)) }
            : (fallback[i] || fallback[fallback.length - 1] || { x: 0.5, y: 0.5 });
    });
}

/**
 * The CSS for a theme's gradient wash — stacked radial pools, one per colour,
 * each at its position. Returns 'none' when there is nothing to paint.
 *
 *   colors     ['#hex', …]         the pool colours
 *   positions  [{x,y}, …]          0..1 in the canvas, parallel to colors
 *   mode       'dark' | 'light'    sets the pool alpha
 *   intensity  0..1                lifts the pools' chroma (Zen's "vividness")
 *
 * Mirrored — deliberately — by localGradient() in renderer/lib/theme-editor.js,
 * which draws the same field into the editor's canvas. Change one, change both.
 */
function gradientCss(colors, positions, mode, intensity) {
    const cols = (colors || []).map(c => toLch(c)).filter(Boolean);
    if (!cols.length)
        return 'none';
    const inten = clamp01(intensity == null ? 0.7 : intensity);
    const pos = positionsFor(colors, positions);
    const a = GRAD_ALPHA[mode === 'light' ? 'light' : 'dark'];
    const layers = cols.map((c, i) => {
        const p = pos[i] || { x: 0.5, y: 0.5 };
        // Keep the pool's own lightness so a colour reads as itself; lift its
        // chroma by intensity so a vivid theme pools vividly.
        const hex = fromLch({ L: c.L, C: c.C * (0.55 + inten * 0.75), h: c.h });
        const x = (p.x * 100).toFixed(1), y = (p.y * 100).toFixed(1);
        return `radial-gradient(ellipse 85% 85% at ${x}% ${y}%, ${rgba(hex, a)} 0%, ${rgba(hex, 0)} 62%)`;
    });
    return layers.join(', ');
}

/**
 * Derive a complete token set.
 *
 *   seed = { mode: 'dark' | 'light', base: '#hex', accent: '#hex', ink?: '#hex' }
 *
 * `ink` is optional and only sets the HUE and CHROMA of the text steps — never
 * their lightness, which the ramp owns. Omit it and the text takes the
 * ground's hue at low chroma (a near-neutral, which is what three of the four
 * built-ins are).
 *
 * Returns { tokens, icon, mode } — `tokens` keyed by CSS custom property name,
 * `icon` the two colours features/app-icon.js paints the mark from.
 */
/* The wheel is a CONSTANT-LIGHTNESS slice — angle is hue, radius is chroma, and
   every dot it writes sits at WHEEL_L. So a dot's lightness carries nothing the
   user can see or set, which is why how dark the ground sits is its own field
   on the seed (`level`, 0..1 across the mode's band) rather than something read
   off the first dot. Reading it off the dot is what made a theme forked from a
   built-in come out nothing like it, and made the first drag jump: the fork's
   dots came in at the built-in's own lightness and the wheel then rewrote them
   at WHEEL_L.

   A seed with no `level` keeps the old reading, so every theme saved before
   this derives exactly as it did — and since the wheel only ever wrote dots at
   WHEEL_L, that old reading was already a constant in practice (0.176 dark,
   0.932 light), which is what the band below is centred on. */
const WHEEL_L = 0.72;
const GROUND_L = { dark: [0.06, 0.30], light: [0.88, 0.98] };
/* Where a level-LESS seed already sits, expressed on the band — not a tidy 0.5.
   The old reading was `0.09 + dotL * 0.12`, and the wheel only ever places dots
   at WHEEL_L, so that is 0.1764 in dark mode: level (0.1764 - 0.06) / 0.24 =
   0.485. Rounding it to 0.5 moved every theme saved before `level` existed the
   first time anything wrote one, which is the one thing this field must not do.
   (Light mode solves to 0.52; the difference between the two is under a
   rounding step of lightness, so one constant covers both.) */
const DEFAULT_LEVEL = 0.485;

/** Where a ground of lightness `L` sits on the mode's band, as 0..1. */
function groundLevelFor(mode, L) {
    const [lo, hi] = GROUND_L[mode === 'light' ? 'light' : 'dark'];
    return clamp01((L - lo) / (hi - lo));
}

/**
 * A user theme is picked as DOTS ON A WHEEL, not as named roles.
 *
 * That is the model the browsers this design follows use: angle is hue, radius
 * is chroma, and one to three dots make the palette. It works because the user
 * is never asked what a "ground" or an "ink" is — they drag until they like it,
 * and the ramp turns that into a browser. `intensity` scales how much of the
 * picked chroma survives; `level` is how dark the ground sits; `grain` is
 * texture over the chrome.
 *
 * Returns the { base, accent } the ramp below already understands, so both seed
 * shapes — the wheel's `colors` and the built-ins' explicit roles — go through
 * exactly one derivation.
 */
function rolesFromColors(seed) {
    const picked = (Array.isArray(seed.colors) ? seed.colors : [])
        .map(c => toLch(c)).filter(Boolean);
    if (!picked.length)
        return null;
    const intensity = clamp01(seed.intensity == null ? 0.7 : seed.intensity);
    const primary = picked[0];
    /* The ground is the first dot's hue and a share of its chroma set by the
       intensity slider, at the level the seed asks for. */
    const dark = (seed.mode !== 'light');
    const groundBand = GROUND_L[dark ? 'dark' : 'light'];
    const hasLevel = Number.isFinite(Number(seed.level));
    const base = fromLch({
        L: hasLevel
            ? groundBand[0] + (groundBand[1] - groundBand[0]) * clamp01(Number(seed.level))
            : (dark ? 0.09 + primary.L * 0.12 : 0.86 + primary.L * 0.10),
        C: primary.C * intensity,
        h: primary.h,
    });
    /* The accent is the most saturated dot that ISN'T the ground — with one dot
       it is that dot, brought up to a lightness that can mark a selected row. */
    const rest = picked.length > 1 ? picked.slice(1) : picked;
    const pick = rest.reduce((a, b) => (b.C > a.C ? b : a));
    /* The accent's lightness band is set by the MODE, not by where the dot
       happened to land. A sand-coloured dot on a light theme is a lovely
       ground and an invisible accent — clamping it into the band is what keeps
       one dot enough to make a whole theme. */
    const band = dark ? [0.58, 0.80] : [0.42, 0.60];
    /* A grey dot has no hue to speak of — atan2 on near-zero chroma returns
       whatever rounding left behind, so boosting it produced a mustard accent
       from a neutral pick. A colourless choice gets the house accent instead. */
    const accent = pick.C < 0.02
        ? '#e5484d'
        : fromLch({
            L: Math.min(band[1], Math.max(band[0], pick.L)),
            C: Math.max(0.12, pick.C),
            h: pick.h,
        });
    return { base, accent, picked, intensity };
}

function derive(seed) {
    const mode = seed && seed.mode === 'light' ? 'light' : 'dark';
    const wheel = seed && Array.isArray(seed.colors) ? rolesFromColors(seed) : null;
    const ground = toLch(wheel ? wheel.base : (seed && seed.base)) || { L: 0.2, C: 0, h: 0 };
    const accentLch = toLch(wheel ? wheel.accent : (seed && seed.accent)) || { L: 0.62, C: 0.19, h: 25 };
    const vivid = !!(seed && seed.vivid);
    const [lo, hi] = (vivid ? VIVID_L_WINDOW : L_WINDOW)[mode];
    const L0 = Math.min(hi, Math.max(lo, ground.L));
    const r = RAMP[mode];
    const tl = TEXT_L[mode];
    /* How far apart the layers sit has to shrink as the ground gets brighter.
       The offsets are tuned for a near-black dark ground, where there is a
       whole range above to climb into. On a vivid ground at L 0.45 the same
       climb puts a card at 0.54 — a mid-tone with no room left for secondary
       ink at 4.5:1 in EITHER direction, so the palette became unsolvable and
       the ink fell back to white. Compressing the steps keeps the layers
       distinguishable and keeps the headroom the text needs. */
    const headroom = mode === 'dark'
        ? Math.min(1, Math.max(0.42, 1 - Math.max(0, L0 - 0.12) * 1.5))
        : 1;
    const step = k => Math.min(1, Math.max(0, L0 + r[k] * headroom));

    const groundC = Math.min(ground.C, vivid ? VIVID_CHROMA_MAX : GROUND_CHROMA_MAX);
    const inkLch = seed && seed.ink ? toLch(seed.ink) : null;
    const textH = inkLch ? inkLch.h : ground.h;
    const textC = inkLch
        ? Math.min(inkLch.C, INK_CHROMA_MAX)
        : Math.min(ground.C, TEXT_CHROMA_MAX);
    /* Each ground layer is the ground hue/chroma at its ramp lightness, PLUS the
       depth axis: a per-layer chroma multiplier and hue drift (see DEPTH). At
       depth 0 this collapses to the old `fromLch(step, groundC, ground.h)`. */
    const depth = clamp01(seed && seed.depth != null ? Number(seed.depth) : DEPTH_DEFAULT);
    const dmap = DEPTH[mode];
    const gKey = (key) => {
        const d = dmap[key] || { dh: 0, cMul: 1 };
        const C = Math.max(0, groundC * (1 + (d.cMul - 1) * depth));
        return fromLch({ L: step(key), C, h: ground.h + d.dh * depth });
    };
    const t = L => fromLch({ L, C: textC, h: textH });

    /* Secondary and tertiary ink SOLVE for their contrast floor instead of
       sitting at a fixed lightness.
       A constant works while the ground is near-black or near-white, and
       breaks the moment a ground is neither: on a vivid blue chrome, --text-2
       at L 0.72 lands at 2.8:1 and the captions are unreadable. Starting from
       the ramp's value and walking away from the ground until the floor is met
       keeps the intended tone on ordinary themes — the loop exits immediately
       — and rescues the ones where the constant was never going to work. */
    /* `apart` is the lightness a candidate must keep from an already-chosen
       tone. Contrast alone is not enough: on a bright ground the nearest
       solution for secondary ink was pure white, which clears every floor and
       is exactly the primary — legible, and with the hierarchy the two tones
       exist to carry thrown away. */
    const meets = (L, floor, grounds, apart) => {
        if (apart && Math.abs(L - apart.L) < apart.min)
            return null;
        const hex = t(L);
        return grounds.every(bg => contrast(hex, bg) >= floor) ? hex : null;
    };
    const solve = (startL, floor, grounds, apart = null) => {
        const meetsAt = (L) => meets(L, floor, grounds, apart);
        const hit = meetsAt(startL);
        if (hit)
            return hit;                       // the ramp's own value already works
        /* Search BOTH ways and take whichever clears the floor first. Going
           only in the mode's direction sent Blocks' secondary ink to pure
           white: legible, and identical to the primary, so the hierarchy the
           two tones exist to carry was gone. On a bright ground the answer is
           darker ink, and it is only findable by looking. */
        for (let d = 0.02; d <= 1; d += 0.02) {
            const up = startL + d <= 1 ? meetsAt(startL + d) : null;
            const down = startL - d >= 0 ? meetsAt(startL - d) : null;
            if (up && down)
                return mode === 'dark' ? up : down;   // tie → the mode's instinct
            if (up)
                return up;
            if (down)
                return down;
        }
        return t(mode === 'dark' ? 1 : 0);
    };

    /* Hairlines and washes are the ink colour at low alpha, not a fixed white:
       a light theme needs dark hairlines, and both need to sit on the ground's
       hue or the chrome looks like two themes bolted together. */
    const inkRgb = hexToRgb(t(mode === 'dark' ? 0.98 : 0.12)) || [0, 0, 0];
    const ink = (alpha) => `rgba(${inkRgb.map(v => Math.round(clamp01(v) * 255)).join(',')},${alpha})`;

    const accent = fromLch(accentLch);
    /* --accent-2 is the pressed/darker step; --accent-ink is what sits ON the
       accent, chosen by contrast rather than assumed to be white — a yellow
       accent with white text is unreadable, and this is a real pick users make. */
    const accent2 = fromLch({ L: Math.max(0.20, accentLch.L - 0.10), C: accentLch.C * 0.95, h: accentLch.h });
    const accentInk = contrast(accent, '#ffffff') >= contrast(accent, '#12080a')
        ? fromLch({ L: 0.98, C: 0.008, h: accentLch.h })
        : fromLch({ L: 0.16, C: 0.03, h: accentLch.h });
    const aRgb = (hexToRgb(accent) || [0, 0, 0]).map(v => Math.round(clamp01(v) * 255));

    /* --danger must never be mistakable for --accent. When the accent is
       already red, push danger lighter and hotter so a destructive row and a
       selected row still read differently (the rule themes.css states). */
    const accentIsRed = (accentLch.h > 5 && accentLch.h < 55) && accentLch.C > 0.09;
    const dangerHue = accentIsRed ? 22 : 27;
    const dangerC = accentIsRed ? 0.17 : 0.19;
    let danger = fromLch({ L: mode === 'dark' ? 0.74 : 0.55, C: dangerC, h: dangerHue });
    {   // …and must stay visible on a card, which a bright ground can undo.
        const card = gKey('surface');
        const stepL = mode === 'dark' ? 0.02 : -0.02;
        let L = mode === 'dark' ? 0.74 : 0.55;
        for (let i = 0; i < 40 && contrast(danger, card) < 3; i++) {
            L += stepL;
            if (L > 1 || L < 0)
                break;
            danger = fromLch({ L, C: dangerC, h: dangerHue });
        }
    }

    const textHex = solve(tl.text, 4.5, [gKey('page'), gKey('surface')]);
    /* Secondary ink normally clears 4.5:1, the body-text floor. A vivid ground
       is the one case where that is unachievable rather than merely awkward:
       on a mid-tone chrome there is no lightness in either direction that
       clears 4.5 against both the shell and a card AND stays distinct from the
       primary ink — the only solutions are white, which IS the primary. So a
       vivid theme drops secondary ink to 3:1, the floor for text that is not
       the thing you are reading. Body text keeps 4.5 everywhere, always. */
    const text2Hex = solve(tl.text2, vivid ? 3 : 4.5, [gKey('shell'), gKey('surface')],
        { L: toLch(textHex).L, min: 0.10 });

    /* Tertiary ink is the DIMMEST tone, and solving it independently could put
       it on the wrong side of the secondary — on Blocks it came out lighter
       than --text-2, so the three tiers ran bright, dim, bright. Walk down from
       the secondary toward the ground instead and stop at the last step that
       still clears 3:1: dimmer than --text-2 by construction, legible by test. */
    const text3Hex = (() => {
        const grounds = [gKey('shell'), gKey('surface')];
        const toward = mode === 'dark' ? -0.02 : 0.02;
        const startL = toLch(text2Hex).L;
        let best = text2Hex;
        for (let L = startL + toward; L >= 0 && L <= 1; L += toward) {
            const hex = t(L);
            if (!grounds.every(bg => contrast(hex, bg) >= 3))
                break;
            best = hex;
        }
        return best;
    })();

    const tokens = {
        '--shell': gKey('shell'),
        '--page': gKey('page'),
        '--bg': gKey('bg'),
        '--surface': gKey('surface'),
        '--surface-2': gKey('surface2'),
        '--text': textHex,
        '--text-2': text2Hex,
        '--text-3': text3Hex,
        '--border': ink(0.10),
        '--border-2': ink(0.18),
        '--hover': ink(0.06),
        '--active-bg': ink(0.11),
        '--accent': accent,
        '--accent-2': accent2,
        '--accent-wash': `rgba(${aRgb.join(',')},0.20)`,
        '--accent-ink': accentInk,
        '--danger': danger,
        /* Light grounds need a lighter shadow: the alpha that reads as depth on
           a dark shell reads as dirt on a pale one. This was a hand-written
           rule naming the two light themes that shipped, so a third light theme
           — or any the user makes — silently got the dark one. */
        '--shadow-pop': mode === 'light'
            ? '0 10px 30px rgba(30,35,60,0.14), 0 2px 6px rgba(30,35,60,0.08)'
            : '0 16px 40px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.30)',
        /* Depth, part two: surfaces catch light instead of being flat fills.
           --surface-hi is the top-edge highlight (the macOS "lit edge") — the
           card already had a fixed 8% one; this keeps that as the baseline and
           strengthens it with depth. --surface-grad is a whisper of a top-lighter
           gradient, absent at depth 0. surface.css applies both to .surface-card. */
        '--surface-hi': `inset 0 0.5px 0 rgba(255,255,255,${round((mode === 'light' ? 0.9 : 0.08) + (mode === 'light' ? 0 : 0.10) * depth, 3)})`,
        '--surface-grad': depth > 0
            ? `linear-gradient(180deg, rgba(255,255,255,${round((mode === 'light' ? 0.42 : 0.03) * depth, 3)}) 0%, rgba(255,255,255,0) 42%)`
            : 'none',
    };

    /* The chrome's wash — the theme's gradient, painted OVER --shell rather than
       replacing it, so everything that reads --shell as a flat colour (the
       vibrancy mix, the tab-strip scroll fades) keeps working. The colours pool
       at their positions (the Zen model); a seed with no colours[] — the four
       role-based built-ins — has no gradient and stays a single flat ground. */
    /* A gradient needs at least two pools. One colour already tints the whole
       chrome through the ground (colors[0] sets the ground's hue), so a single
       radial of the same hue would be redundant — and, crucially, it means
       forking a flat built-in stays flat until you add a second colour, rather
       than the browser changing the instant you open the editor. */
    /* A role-based theme (no colours[]) previously stayed a single flat ground.
       With depth it gets a faint tonal wash in its own hue instead — see
       faintWash. Zen (colours[]) themes keep their explicit pooled gradient. */
    const gradColors = seed && Array.isArray(seed.colors) ? seed.colors : null;
    tokens['--shell-wash'] = gradColors && gradColors.length >= 2
        ? gradientCss(gradColors, seed.positions, mode, wheel ? wheel.intensity : 1)
        : 'none';
    tokens['--grain'] = String(seed && seed.grain != null ? clamp01(seed.grain) : 0);

    return {
        mode,
        tokens,
        /* The icon is the mark on the theme's own ground — the shell, so the
           dock tile matches the chrome behind the window. */
        icon: { field: tokens['--shell'], mark: tokens['--text'] },
    };
}

/** Serialise a token map into a CSS rule for insertCSS/`<style>`. */
function toCss(tokens, selector = 'html[data-theme="custom"]') {
    const body = Object.entries(tokens).map(([k, v]) => `${k}:${v}`).join(';');
    return `${selector}{${body}}`;
}

/**
 * Is this seed usable? A theme the user can save must still be a browser they
 * can read, so the two contrasts that carry every screen are checked here
 * rather than left to taste.
 */
function validate(seed) {
    const errors = [];
    // Two seed shapes reach here: the wheel's list of dots, and the built-ins'
    // explicit base/accent roles.
    if (seed && Array.isArray(seed.colors)) {
        const good = seed.colors.filter(c => hexToRgb(c));
        if (!good.length)
            errors.push('pick at least one colour');
        if (good.length > 3)
            errors.push('three colours is the most a gradient can hold');
    }
    else {
        if (!hexToRgb(seed && seed.base))
            errors.push('base is not a hex colour');
        if (!hexToRgb(seed && seed.accent))
            errors.push('accent is not a hex colour');
    }
    if (errors.length)
        return { ok: false, errors };
    const { tokens } = derive(seed);
    const body = contrast(tokens['--text'], tokens['--page']);
    const onAccent = contrast(tokens['--accent-ink'], tokens['--accent']);
    /* The accent has to be visible AGAINST the ground, which is a different
       question from whether text on it is readable — and the one that actually
       bites. Lightness comes from the ramp, so body text can never come out
       unreadable however the colours are picked; an accent chosen a shade off
       the page can, and then the selected row, the focus ring and every live
       state mark nothing. The shipped themes run 3.5–4.7 here. */
    const accentOnPage = contrast(tokens['--accent'], tokens['--page']);
    if (body < 4.5)
        errors.push(`body text on the page is ${round(body, 2)}:1, below 4.5:1`);
    if (onAccent < 3)
        errors.push(`text on the accent is ${round(onAccent, 2)}:1, below 3:1`);
    if (accentOnPage < 2)
        errors.push(`the accent is ${round(accentOnPage, 2)}:1 against the page — too close to it to mark anything`);
    return {
        ok: errors.length === 0, errors,
        contrast: { body: round(body, 2), onAccent: round(onAccent, 2), accentOnPage: round(accentOnPage, 2) },
    };
}

module.exports = {
    derive, toCss, validate, groundLevelFor, gradientCss, positionsFor,
    // exported for tests and for the icon renderer
    toLch, fromLch, contrast, luminance, hexToRgb, rgbToHex, RAMP, L_WINDOW, rolesFromColors,
    WHEEL_L, GROUND_L, DEFAULT_LEVEL, GROUND_CHROMA_MAX, DEFAULT_POS,
};
