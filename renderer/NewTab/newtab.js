// Northstar — home / new-tab page.
// Deliberately makes zero network requests of its own (no weather, no
// geolocation, no external fonts) — the home page never phones home.

const DAYS   = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
                'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function greetingForHour(h) {
  if (h < 5)  return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Good night';
}

const pad = (n) => String(n).padStart(2, '0');

function tick() {
  const now = new Date();
  const t = document.getElementById('time-display');
  const g = document.getElementById('greeting-text');
  const d = document.getElementById('date-display');
  if (t) t.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  if (g) g.textContent = greetingForHour(now.getHours());
  if (d) d.textContent = `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
}

// ── Background — ASCII-rendered mountains under a starry sky ─────────────────
// The scene — layered ridges, a field of stars, and one genuinely bright
// Polaris — is computed as a smooth luminance field, then rendered the way an
// ASCII shader would: each character cell maps its brightness through a glyph
// ramp (· : ; i I W), drawn on canvas in the theme's mono font and ink
// colour. Deterministic (seeded hash), never animated, no network use.

function hash(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
const smooth = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };

// The theme's ink colour (--text, #rrggbb) as [r, g, b] for canvas alphas.
function inkRGB() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (!m) return [230, 228, 228];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// The scene occupies the bottom-right 70% of the page and dissolves along its
// top/left boundary, so the composition reads as one anchored piece of art
// rather than wallpaper.
const REGION = { x0: 0.30, y0: 0.30 };

function renderBackground() {
  const canvas = document.getElementById('bg');
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth, h = window.innerHeight;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const [R, G, B] = inkRGB();
  const ink = (a) => `rgba(${R},${G},${B},${a})`;

  // Character grid in the theme's mono font.
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
            || "ui-monospace, Menlo, monospace";
  const CW = 8, CH = 13;                          // cell size (px)
  const cols = Math.ceil(w / CW), rows = Math.ceil(h / CH);
  ctx.font = `11px ${mono}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  // Region-space coordinates: (u, v) ∈ [0,1] inside the bottom-right block.
  const toU = (x) => (x - REGION.x0) / (1 - REGION.x0);
  const toV = (y) => (y - REGION.y0) / (1 - REGION.y0);

  // ── Three mountain planes with atmospheric perspective ───────────────────
  // Each plane: tent-function skyline + its own light. The sun (well, star-
  // light) comes from the upper LEFT: west faces catch it, east faces fall
  // into shadow — that directional shading is what gives the relief depth.
  const ridge = (u, peaks) => {
    let hh = 0;
    for (const p of peaks) {
      const t = Math.max(0, 1 - Math.abs(u - p.cx) / p.hw);
      hh = Math.max(hh, p.a * (t * t * (3 - 2 * t)));
    }
    return hh;
  };
  const PLANES = [
    { // far range — a low hazy wall near the region's midline
      peaks: [{ cx: 0.12, a: 0.20, hw: 0.30 }, { cx: 0.46, a: 0.26, hw: 0.24 }, { cx: 0.85, a: 0.22, hw: 0.32 }],
      base: 0.52, body: 0.12, fadeTo: 0.02, litGain: 0.12, texture: 0,
    },
    { // mid range
      peaks: [{ cx: 0.28, a: 0.30, hw: 0.24 }, { cx: 0.72, a: 0.24, hw: 0.26 }],
      base: 0.70, body: 0.24, fadeTo: 0.04, litGain: 0.20, texture: 0.05,
    },
    { // near range — dominant summit under Polaris
      peaks: [{ cx: 0.18, a: 0.22, hw: 0.22 }, { cx: 0.66, a: 0.44, hw: 0.26 }, { cx: 1.04, a: 0.26, hw: 0.24 }],
      base: 1.00, body: 0.40, fadeTo: 0.08, litGain: 0.30, texture: 0.10,
    },
  ];
  // Valley fog: pale horizontal bands pooling at each plane's foot — they
  // separate the ranges the way haze does in a real mountain evening.
  const fogAt = (v) => 0.55 * Math.exp(-Math.pow((v - 0.545) / 0.048, 2))
                     + 0.45 * Math.exp(-Math.pow((v - 0.725) / 0.042, 2));

  // Scene luminance in region space. Nearest plane wins (it occludes).
  const du = 0.004;
  const sceneLum = (u, v) => {
    for (let i = PLANES.length - 1; i >= 0; i--) {
      const P = PLANES[i];
      const rimV = P.base - ridge(u, P.peaks);
      if (v < rimV) continue;                     // sky above this plane
      const span = Math.max(0.08, P.base - rimV);
      const t = (v - rimV) / span;                // 0 crest → 1 foot
      // No crest line: the body is simply brightest at the top and fades
      // down — the skyline emerges from the gradient, not from an outline.
      // Directional light: west (lit) faces brighter, east faces shadowed.
      const slope = (ridge(u + du, P.peaks) - ridge(u - du, P.peaks)) / (2 * du);
      const lit = 1 + P.litGain * Math.max(-1, Math.min(1, -slope * 1.6));
      // Couloirs: two interleaved sine striations run down the faces —
      // deterministic texture, strongest on the near plane, calm in the haze.
      const gully = 1 + P.texture * Math.sin(u * 61 + i * 7) * Math.sin(u * 23 - v * 5);
      // Body fades toward the foot, then the valley fog eats it.
      let lum = (P.body * (1 - 0.62 * t) + P.fadeTo * t) * lit * gully;
      lum *= 1 - 0.85 * fogAt(v);
      return Math.max(0, lum);
    }
    return 0;
  };

  // UI exclusion: soft ellipse behind the clock/search column (viewport space).
  const clearing = (x, y) => {
    const ex = (x - 0.5) / 0.40, ey = (y - 0.43) / 0.34;
    return smooth(0.88, 1.18, Math.sqrt(ex * ex + ey * ey));
  };
  // The region dissolves at its top/left boundary instead of cutting hard.
  const regionFade = (u, v) => smooth(-0.02, 0.14, u) * smooth(-0.02, 0.12, v);

  // Polaris: in the region's sky, above the dominant summit.
  const pu = 0.66, pv = 0.14;
  const pc = Math.round((REGION.x0 + pu * (1 - REGION.x0)) * cols);
  const pr = Math.round((REGION.y0 + pv * (1 - REGION.y0)) * rows);

  // Glyph ramp, dark → bright — fine steps low down so shading walks up
  // gradually instead of jumping to heavy glyphs.
  const RAMP = [[0.10, '·'], [0.16, ':'], [0.24, ';'], [0.34, 'i'], [0.46, 'I'], [0.60, 'H'], [1.5, 'W']];
  const glyphFor = (lum) => { if (lum < 0.055) return null; for (const [lim, g] of RAMP) if (lum < lim) return g; return 'W'; };

  // Star field: three magnitudes, seeded, sky cells of the region only.
  const starCell = new Map();                     // r * cols + c → [glyph, alpha]
  for (let i = 0; i < 80; i++) {
    const u = hash(i * 4 + 1), v = hash(i * 4 + 2) * 0.85;
    const c = Math.floor((REGION.x0 + u * (1 - REGION.x0)) * cols);
    const r = Math.floor((REGION.y0 + v * (1 - REGION.y0)) * rows);
    if (Math.hypot(c - pc, (r - pr) * (CH / CW)) < 8) continue;
    const m = hash(i * 4 + 3);                    // magnitude
    const glyph = m > 0.94 ? '+' : (m > 0.75 ? '·' : '.');
    const a = (0.09 + 0.26 * m) * (1 - 0.45 * v);
    starCell.set(r * cols + c, [glyph, a]);
  }

  // Polaris' glow and diffraction spikes, in grid space.
  const polarisLum = (c, r) => {
    const dc = c - pc, dr = (r - pr) * (CH / CW);
    const d = Math.hypot(dc, dr);
    let lum = 0.80 * Math.exp(-d / 1.8);
    if (r === pr) lum = Math.max(lum, 0.75 * Math.max(0, 1 - Math.abs(dc) / 6));
    if (c === pc) lum = Math.max(lum, 0.75 * Math.max(0, 1 - Math.abs(dr) / 5));
    return lum < 0.09 ? 0 : lum;
  };

  for (let r = 0; r < rows; r++) {
    for (let cc = 0; cc < cols; cc++) {
      const x = (cc + 0.5) / cols, y = (r + 0.5) / rows;
      const u = toU(x), v = toV(y);
      if (u < -0.01 || v < -0.01) continue;       // outside the 70% region
      const cv = clearing(x, y) * regionFade(u, v);
      const gx = cc * CW + CW / 2, gy = r * CH + CH / 2;

      // Polaris core cell: always bright, above everything.
      if (cc === pc && r === pr) {
        ctx.fillStyle = ink(1);
        ctx.fillText('✦', gx, gy);
        continue;
      }

      const pl = polarisLum(cc, r);
      const scene = sceneLum(u, v) * cv;
      const lum = Math.max(scene, pl);
      const star = starCell.get(r * cols + cc);

      if (star && lum < 0.1 && cv > 0.4) {        // stars live in empty sky
        ctx.fillStyle = ink(star[1]);
        ctx.fillText(star[0], gx, gy);
        continue;
      }
      const g = glyphFor(lum);
      if (!g) continue;
      // Character density carries the shading; alpha follows it gently, with
      // a low ceiling so the scene stays behind the page rather than on it.
      ctx.fillStyle = ink(Math.min(0.40, 0.09 + 0.40 * lum) * (pl > scene ? 1 : Math.max(cv, 0)));
      ctx.fillText(g, gx, gy);
    }
  }
}

// Mirror the omnibox: bare domains become URLs, everything else is a search.
function resolveQuery(raw) {
  const q = raw.trim();
  if (!q) return null;
  if (/^https?:\/\//i.test(q)) return q;
  if (q.includes('.') && !q.includes(' ')) return 'https://' + q;
  return 'https://www.google.com/search?q=' + encodeURIComponent(q);
}

document.addEventListener('DOMContentLoaded', () => {
  tick();
  // Align the first update to the top of the next minute, then tick each minute.
  const secs = new Date().getSeconds();
  setTimeout(() => { tick(); setInterval(tick, 60000); }, (60 - secs) * 1000);

  renderBackground();
  let bgTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(renderBackground, 150);
  });

  // Keyboard hint matches the platform's focus-address-bar shortcut.
  const kbd = document.getElementById('search-kbd');
  if (kbd && !/mac/i.test(navigator.platform)) kbd.textContent = 'Ctrl L';

  const form  = document.getElementById('search-form');
  const input = document.getElementById('search-input');

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const url = resolveQuery(input.value);
      if (url) window.location.href = url;
    });
  }

  // Let clicks on the page dismiss any open chrome overlay (menu, prompts).
  if (window.electronAPI && window.electronAPI.windowClick) {
    window.addEventListener('click', (e) => {
      window.electronAPI.windowClick({ x: e.clientX, y: e.clientY });
    });
  }
});
