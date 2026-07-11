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

  // One clear massif on a continuous base, with a lower secondary peak, anchored
  // to the bottom-right and fading out toward the top-left of the box.
  const base  = 1.04;
  const peaks = [
    { cx: 0.62, a: 0.20, hw: 1.05 },   // broad base connecting the range
    { cx: 0.62, a: 0.58, hw: 0.34 },   // dominant peak (under the star)
    { cx: 0.90, a: 0.36, hw: 0.20 },   // secondary peak to the right
  ];
  const ridge = (xx) => ridgeY(xx, base, peaks);
  const dx = 1 / cols;
  const edge = (x, y) => smooth(0.02, 0.30, x) * smooth(-0.1, 0.18, y * 0.5 + 0.2);

  for (let c = 0; c < cols; c++) {
    const x = c / cols;
    const rY = ridge(x);
    const span = Math.max(0.05, base - rY);                 // ridge → base height
    const slope = (ridge(x + dx) - ridge(x - dx)) / (2 * dx); // + = descends right
    const lit = clamp01(0.5 - slope * 0.6);                 // light from upper-left
    for (let r = 0; r < rows; r++) {
      const y = r / rows;
      const ef = edge(x, y);
      if (y >= rY) {
        const t = (y - rY) / span;                          // 0 at ridge, 1 at base
        let d;
        if (y - rY < 0.016) d = 1;                          // crisp lit rim
        else {
          const grad  = clamp01(1 - 0.5 * t);               // solid up top, eases down
          const shade = 0.52 + 0.72 * lit;                  // 3D face shading (lit left)
          const tex   = 0.82 + 0.34 * fbm(x * 6.0, y * 6.0 * AR); // coherent texture
          d = grad * shade * tex;
          if (t > 0.6) d *= smooth(1.0, 0.6, t);            // dissolve toward the base
        }
        d *= ef;
        if (Math.random() < clamp01(d)) grid[r][c] = (d > 0.8 && Math.random() < 0.16) ? ':' : '·';
      } else if (Math.random() < 0.0016 * ef) {             // sparse sky stars
        grid[r][c] = Math.random() < 0.12 ? '*' : '·';
      }
    }
  }

  // North star — small, crisp, 4-pointed — above the dominant peak.
  const sc = Math.round(0.70 * cols), sr = Math.round(0.16 * rows);
  const put = (r, c, ch) => { if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch; };
  const RH = 8, RV = Math.round(8 / AR) + 1;
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

  // Fill the box itself (70vw × 70vh), not the whole window.
  const boxW = pre.clientWidth  || window.innerWidth  * 0.7;
  const boxH = pre.clientHeight || window.innerHeight * 0.7;
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
