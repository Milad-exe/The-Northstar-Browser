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
const smooth = (a, b, t) => { t = Math.max(0, Math.min(1, (t - a) / (b - a))); return t * t * (3 - 2 * t); };

function ridgeY(x, base, peaks) {
  let h = 0;
  for (const p of peaks) {
    const t = Math.max(0, 1 - Math.abs(x - p.cx) / p.hw);   // triangular tent
    h = Math.max(h, p.a * (t * t * (3 - 2 * t)));           // smoothstepped
  }
  h += (hash(Math.round(x * 400) * 1.7) - 0.5) * 0.012;     // jagged rim
  return base - h;
}

function buildAsciiScene(cols, rows, cellAR) {
  const AR = cellAR || 2.0;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(' '));

  const base  = 1.02;
  // A dominant peak with the north star above it, plus a secondary summit — the
  // scene is anchored to the bottom-right and fades out toward the top-left.
  const peaks = [
    { cx: 0.62, a: 0.66, hw: 0.31 },
    { cx: 0.86, a: 0.40, hw: 0.18 },
    { cx: 0.30, a: 0.34, hw: 0.21 },
  ];

  const streak = new Array(cols);
  for (let c = 0; c < cols; c++) streak[c] = hash(c * 3.3);

  const edge = (x, y) => smooth(0.02, 0.30, x) * smooth(-0.05, 0.22, y * 0.6 + 0.15);

  const pick = (d) => {
    if (Math.random() > d) return ' ';
    if (d > 0.85 && Math.random() < 0.14) return ':';
    return '·';
  };

  for (let c = 0; c < cols; c++) {
    const x = c / cols;
    const ridge = ridgeY(x, base, peaks);
    const reach = 0.10 + streak[c] * 0.30;
    for (let r = 0; r < rows; r++) {
      const y = r / rows;
      const ef = edge(x, y);
      if (y >= ridge) {
        const depth = y - ridge;
        let d = depth < 0.14 ? 0.95 : 0.95 * Math.exp(-(depth - 0.14) / reach);
        d *= 0.8 + 0.32 * streak[c];                  // gentle vertical striation
        d *= ef;
        const ch = pick(Math.min(1, d));
        if (ch !== ' ') grid[r][c] = ch;
      } else {
        const p = 0.0022 * (0.4 + (1 - y)) * ef;      // few faint sky stars
        if (Math.random() < p) grid[r][c] = Math.random() < 0.12 ? '*' : '·';
      }
    }
  }

  // North star, above the dominant peak.
  const sc = Math.round(0.68 * cols), sr = Math.round(0.15 * rows);
  const put = (r, c, ch) => { if (r >= 0 && r < rows && c >= 0 && c < cols) grid[r][c] = ch; };
  const G = 5;
  for (let dr = -G; dr <= G; dr++) for (let dc = -Math.round(G * AR); dc <= G * AR; dc++) {
    const rr = Math.hypot(dc / AR, dr);
    if (rr <= G && Math.random() < Math.exp(-rr / 1.5) * 0.45) put(sr + dr, sc + dc, '·');
  }
  const RH = 10;
  for (let k = 1; k <= RH; k++) {
    const p = Math.pow(1 - k / (RH + 1), 0.6);
    const g = k <= 3 ? '*' : '·';
    if (Math.random() < p) put(sr, sc + k, g);
    if (Math.random() < p) put(sr, sc - k, g);
  }
  const RV = Math.round(RH / AR) + 2;
  for (let k = 1; k <= RV; k++) {
    const p = Math.pow(1 - k / (RV + 1), 0.6);
    const g = k <= 2 ? '*' : '·';
    if (Math.random() < p) put(sr + k, sc, g);
    if (Math.random() < p) put(sr - k, sc, g);
  }
  for (let k = 1; k <= 3; k++) {
    const p = 0.75 - k * 0.18;
    if (Math.random() < p) put(sr + k, sc + Math.round(k * AR), '·');
    if (Math.random() < p) put(sr - k, sc - Math.round(k * AR), '·');
    if (Math.random() < p) put(sr + k, sc - Math.round(k * AR), '·');
    if (Math.random() < p) put(sr - k, sc + Math.round(k * AR), '·');
  }
  put(sr, sc, '*');
  put(sr, sc - 1, '*'); put(sr, sc + 1, '*'); put(sr - 1, sc, '*'); put(sr + 1, sc, '*');
  put(sr, sc - 2, '+'); put(sr, sc + 2, '+');

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
