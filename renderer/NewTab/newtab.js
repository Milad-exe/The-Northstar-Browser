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

// ── ASCII starfield background ───────────────────────────────────────────────
// A stippled "north star over the mountains" scene, generated to fit the
// viewport. Two summits frame the edges, a low valley sits behind the clock,
// and the north star hangs above the gap. Purely decorative, no network use.

function hash(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }
const smooth  = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };
const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Coherent value noise — interpolated hash grid — so the stipple clusters into
// a natural texture instead of looking like random static.
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const h = (a, b) => hash(a * 157.3 + b * 113.7);
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const tl = h(xi, yi), tr = h(xi + 1, yi), bl = h(xi, yi + 1), br = h(xi + 1, yi + 1);
  return (tl * (1 - u) + tr * u) * (1 - v) + (bl * (1 - u) + br * u) * v;
}
const fbm = (x, y) => vnoise(x, y) * 0.65 + vnoise(x * 2.3 + 9.1, y * 2.3 + 3.7) * 0.35;

function ridgeY(x, base, peaks) {
  let h = 0;
  for (const p of peaks) {
    const t = Math.max(0, 1 - Math.abs(x - p.cx) / p.hw);   // triangular tent
    h = Math.max(h, p.a * (t * t * (3 - 2 * t)));           // smoothstepped
  }
  h += (fbm(x * 14, 7) - 0.5) * 0.02;                       // gentle jagged rim
  return base - h;
}

function buildAsciiScene(cols, rows, cellAR) {
  const AR = cellAR || 2.0;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));
  const put  = (r, c, ch) => { if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch; };

  // Elliptical clearing around the clock / search so the UI floats in calm
  // space. Sized to the UI column only — art may live right beside it.
  const clearing = (x, y) => {
    const ex = (x - 0.5) / 0.26, ey = (y - 0.45) / 0.26;
    const e = Math.sqrt(ex * ex + ey * ey);
    return smooth(0.90, 1.30, e);
  };

  // ── Mountain — shaded heightfield massif (the organic look) ──────────────
  // One dominant peak under Polaris with a secondary summit to its right,
  // fading out toward the left. Density is shaped by slope shading (lit left
  // face / shadowed right face), coherent value-noise texture, a crisp rim,
  // and a dissolving base. Rendered with a SOFT dither — half ordered matrix,
  // half hash noise — so the stipple stays organic without clumping.
  const BAYER8 = [
    [ 0,32, 8,40, 2,34,10,42],[48,16,56,24,50,18,58,26],
    [12,44, 4,36,14,46, 6,38],[60,28,52,20,62,30,54,22],
    [ 3,35,11,43, 1,33, 9,41],[51,19,59,27,49,17,57,25],
    [15,47, 7,39,13,45, 5,37],[63,31,55,23,61,29,53,21],
  ];
  const softDither = (r, c) =>
    0.5 * ((BAYER8[r % 8][c % 8] + 0.5) / 64) + 0.5 * hash(c * 7919 + r * 104729);

  // The dominant summit sits to the RIGHT of the UI column (x > 0.7) so its
  // top never intersects the clearing and the peak reads whole.
  const base  = 1.05;
  const peaks = [
    { cx: 0.70, a: 0.20, hw: 1.05 },   // broad connecting base
    { cx: 0.80, a: 0.50, hw: 0.26 },   // dominant peak (under the star)
    { cx: 0.55, a: 0.26, hw: 0.18 },   // low shoulder toward the valley
  ];
  const ridge = (xx) => {
    let h = 0;
    for (const p of peaks) {
      const t = Math.max(0, 1 - Math.abs(xx - p.cx) / p.hw);
      h = Math.max(h, p.a * (t * t * (3 - 2 * t)));
    }
    h += (fbm(xx * 14, 7) - 0.5) * 0.018;                   // gentle jagged rim
    return base - h;
  };
  const dx = 1 / cols;
  const leftFade = (x) => smooth(0.02, 0.30, x);            // recedes to the west

  for (let c = 0; c < cols; c++) {
    const x = c / cols;
    const rY = ridge(x);
    const span  = Math.max(0.05, base - rY);
    const slope = (ridge(x + dx) - ridge(x - dx)) / (2 * dx);
    const lit   = clamp01(0.5 - slope * 0.6);               // light from upper-left
    for (let r = 0; r < rows; r++) {
      const y = r / rows;
      if (y < rY) continue;
      const t = (y - rY) / span;                            // 0 at rim → 1 at base
      let d;
      if (y - rY < 0.016) d = 1;                            // crisp rim
      else {
        const grad  = clamp01(1 - 0.5 * t);                 // solid up top, eases down
        const shade = 0.52 + 0.72 * lit;                    // 3D face shading
        const tex   = 0.82 + 0.34 * fbm(x * 6.0, y * 6.0 * AR); // coherent texture
        d = grad * shade * tex;
        if (t > 0.6) d *= smooth(1.0, 0.6, t);              // dissolve toward the base
      }
      d *= leftFade(x) * clearing(x, y);
      if (d > softDither(r, c)) grid[r][c] = (d > 0.8 && hash(r * 31 + c) < 0.16) ? ':' : '·';
    }
  }

  // ── Sky — sparse and quiet; stars thin toward the horizon ────────────────
  for (let c = 0; c < cols; c++) {
    const x = c / cols;
    for (let r = 0; r < rows; r++) {
      const y = r / rows;
      if (grid[r][c] !== ' ') continue;
      const p = 0.0017 * (1.15 - y) * clearing(x, y);
      if (Math.random() < p) grid[r][c] = Math.random() < 0.12 ? '*' : '·';
    }
  }

  // ── Ursa Minor — the Little Dipper, its handle ending at Polaris ──────────
  // Offsets are in "sky units" (x right, y down), scaled per grid; the bowl
  // hangs down-left of the pole star exactly as it reads in the north sky.
  // The Dipper wheels around Polaris through the night — this orientation has
  // the handle rising to the upper-right, keeping the whole figure in the
  // empty corner of the sky, well away from the clock.
  const sc = Math.round(0.78 * cols), sr = Math.round(0.19 * rows);
  const S = Math.min(cols * 0.050, (rows * 0.075) * AR);     // constellation scale
  const DIP = [
    { x: 0.00,  y:  0.00 },    // Polaris
    { x: 0.9,   y: -0.55 },    // Yildun
    { x: 1.7,   y: -0.95 },    // Epsilon UMi
    { x: 2.6,   y: -1.15 },    // Zeta UMi (bowl rim)
    { x: 3.6,   y: -1.45 },    // Eta UMi
    { x: 3.5,   y: -2.15 },    // Gamma UMi (Pherkad)
    { x: 2.5,   y: -1.85 },    // Beta UMi (Kochab) — closes the bowl
  ];
  const dipC = (p) => sc + Math.round(p.x * S);
  const dipR = (p) => sr + Math.round(p.y * S / AR);
  // Nothing from the constellation may intrude on the UI clearing.
  const inClear = (rr, cc) => clearing(cc / cols, rr / rows) < 0.25;
  // faint connecting lines (sparse dots), then the member stars on top
  const link = (a, b) => {
    const steps = Math.max(Math.abs(dipC(b) - dipC(a)), Math.abs(dipR(b) - dipR(a)) * 2);
    for (let k = 1; k < steps; k++) {
      if (Math.random() < 0.55) continue;                    // broken, hand-drawn line
      const cc = Math.round(dipC(a) + (dipC(b) - dipC(a)) * k / steps);
      const rr = Math.round(dipR(a) + (dipR(b) - dipR(a)) * k / steps);
      if (grid[rr] && grid[rr][cc] === ' ' && !inClear(rr, cc)) put(rr, cc, '·');
    }
  };
  for (let i = 0; i < DIP.length - 1; i++) link(DIP[i], DIP[i + 1]);
  link(DIP[3], DIP[6]);                                      // close the bowl
  for (let i = 1; i < DIP.length; i++) {
    if (!inClear(dipR(DIP[i]), dipC(DIP[i]))) put(dipR(DIP[i]), dipC(DIP[i]), '*');
  }

  // ── Polaris — the north star, bright core with 4-point rays and glow ──────
  const G = 4;
  for (let dr2 = -G; dr2 <= G; dr2++) for (let dc2 = -Math.round(G * AR); dc2 <= G * AR; dc2++) {
    const rr = Math.hypot(dc2 / AR, dr2);
    if (rr <= G && rr > 1 && Math.random() < Math.exp(-rr / 1.4) * 0.4) put(sr + dr2, sc + dc2, '·');
  }
  const RH = 9, RV = Math.round(9 / AR) + 1;
  for (let k = 1; k <= RH; k++) { const p = 1 - k / (RH + 1); if (Math.random() < p) put(sr, sc + k, k <= 2 ? '*' : '·'); if (Math.random() < p) put(sr, sc - k, k <= 2 ? '*' : '·'); }
  for (let k = 1; k <= RV; k++) { const p = 1 - k / (RV + 1); if (Math.random() < p) put(sr + k, sc, k <= 1 ? '*' : '·'); if (Math.random() < p) put(sr - k, sc, k <= 1 ? '*' : '·'); }
  put(sr, sc, '*'); put(sr, sc - 1, '*'); put(sr, sc + 1, '*'); put(sr - 1, sc, '*'); put(sr + 1, sc, '*');

  return grid.map(row => row.join('').replace(/\s+$/, '')).join('\n');
}

function renderAsciiBackground() {
  const pre = document.getElementById('ascii-bg');
  if (!pre) return;
  // Measure one character cell from the <pre>'s own font metrics.
  const probe = document.createElement('span');
  probe.textContent = '·'.repeat(100);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:inherit;';
  pre.appendChild(probe);
  const cw = probe.getBoundingClientRect().width / 100 || 6.6;
  pre.removeChild(probe);
  const ch = parseFloat(getComputedStyle(pre).lineHeight) || 12;

  const boxW = pre.clientWidth  || window.innerWidth;
  const boxH = pre.clientHeight || window.innerHeight;
  const cols = Math.max(30, Math.ceil(boxW / cw) + 1);
  const rows = Math.max(16, Math.ceil(boxH / ch) + 1);
  pre.textContent = buildAsciiScene(cols, rows, ch / cw);
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

  renderAsciiBackground();
  let bgTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(bgTimer);
    bgTimer = setTimeout(renderAsciiBackground, 150);
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
