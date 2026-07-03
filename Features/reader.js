/**
 * Reader mode + Picture-in-Picture helpers.
 *
 * Both work by running a script inside the page's web contents:
 *  - READERABLE_JS : cheap check on page load → is this an article?
 *  - EXTRACT_JS    : full content extraction when the user enters reader mode
 *  - PIP_JS        : toggle Picture-in-Picture on the most relevant <video>
 *
 * The extractor is a compact, self-contained readability heuristic (no deps):
 * it picks the densest text container, strips chrome/ads, and returns clean
 * HTML that the reader renderer sanitizes (DOMPurify) before displaying.
 */

'use strict';

// Quick "is this readerable" probe — kept cheap so it can run on every load.
const READERABLE_JS = `(() => {
  try {
    if (!/^https?:/.test(location.href)) return false;
    const ps = Array.from(document.querySelectorAll('p'));
    let long = 0, total = 0;
    for (const p of ps) {
      const len = (p.innerText || '').trim().length;
      total += len;
      if (len > 100) long++;
    }
    return long >= 3 && total > 900;
  } catch (_) { return false; }
})()`;

// Full extraction. Returns { ok, title, byline, siteName, dir, html } or { ok:false }.
const EXTRACT_JS = `(() => {
  try {
    const STRIP = 'script,style,noscript,iframe:not([src*="youtube"]):not([src*="vimeo"]),form,button,input,select,textarea,svg,nav,aside,header,footer,[role="navigation"],[role="banner"],[role="complementary"],[aria-hidden="true"]';
    const JUNK = /(^|[\\s_-])(share|sharing|comment|comments|related|recommend|promo|sidebar|nav|navbar|menu|footer|header|social|newsletter|subscribe|subscription|advert|advertis|sponsor|banner|cookie|popup|modal|paywall|meta|breadcrumb|pagination|widget|masthead)($|[\\s_-])/i;

    function textLen(el){ return (el.innerText || '').trim().length; }
    function linkDensity(el){
      const t = textLen(el) || 1;
      let l = 0; el.querySelectorAll('a').forEach(a => l += (a.innerText||'').length);
      return l / t;
    }
    function isJunk(el){
      const s = ((el.className && el.className.toString ? el.className.toString() : '') + ' ' + (el.id||''));
      return JUNK.test(s);
    }

    // Candidate roots, preferring semantic containers.
    const preferred = Array.from(document.querySelectorAll('article,[role="main"],main,[itemprop="articleBody"],.post-content,.entry-content,.article-body,.article-content,.post-body,.story-body'));
    const generic = Array.from(document.querySelectorAll('div,section')).filter(el => {
      const p = el.querySelectorAll('p').length;
      return p >= 3;
    });
    const candidates = [...preferred, ...generic];
    if (!candidates.length) return { ok: false };

    let best = null, bestScore = 0;
    for (const el of candidates) {
      if (isJunk(el)) continue;
      let score = 0;
      el.querySelectorAll('p,pre,blockquote,li').forEach(p => {
        const len = (p.innerText||'').trim().length;
        if (len >= 25) score += Math.min(len, 1000);
      });
      if (el.tagName === 'ARTICLE' || el.getAttribute('role') === 'main') score *= 1.5;
      score *= (1 - Math.min(linkDensity(el), 0.9));
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (!best || bestScore < 400) return { ok: false };

    // Clone and clean.
    const root = best.cloneNode(true);
    root.querySelectorAll(STRIP).forEach(n => n.remove());
    root.querySelectorAll('*').forEach(n => { if (isJunk(n)) n.remove(); });
    // Un-lazy images and drop tiny/tracking ones.
    root.querySelectorAll('img').forEach(img => {
      const real = img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || img.getAttribute('data-original') || img.currentSrc || img.src;
      if (real) img.setAttribute('src', real);
      img.removeAttribute('srcset'); img.removeAttribute('loading');
      const w = parseInt(img.getAttribute('width')||'0',10);
      if ((w && w < 50) || /1x1|pixel|spacer|blank/.test(img.src)) img.remove();
    });
    // Absolutize links/images against the document.
    root.querySelectorAll('a[href]').forEach(a => { try { a.href = new URL(a.getAttribute('href'), location.href).href; a.target='_top'; } catch(_){} });
    root.querySelectorAll('img[src]').forEach(i => { try { i.src = new URL(i.getAttribute('src'), location.href).href; } catch(_){} });
    // Strip inline styles/handlers so the reader theme wins.
    root.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
    root.querySelectorAll('*').forEach(n => { for (const a of Array.from(n.attributes)) { if (/^on/i.test(a.name)) n.removeAttribute(a.name); } });

    const html = root.innerHTML.trim();
    if (html.length < 250) return { ok: false };

    const meta = (sel, attr) => { const el = document.querySelector(sel); return el ? (attr ? el.getAttribute(attr) : el.textContent) : ''; };
    const title = (meta('meta[property="og:title"]','content') || (document.querySelector('h1')||{}).innerText || document.title || '').trim();
    const byline = (meta('meta[name="author"]','content') || meta('[rel="author"]') || meta('.byline') || meta('.author') || '').trim();
    const siteName = (meta('meta[property="og:site_name"]','content') || location.hostname.replace(/^www\\./,'')).trim();

    return { ok: true, title, byline, siteName, dir: document.dir || 'ltr', url: location.href, html };
  } catch (e) { return { ok: false, error: String(e) }; }
})()`;

// Toggle Picture-in-Picture on the best <video> (playing → largest → first).
const PIP_JS = `(() => {
  try {
    if (document.pictureInPictureElement) { document.exitPictureInPicture(); return 'exit'; }
    const vids = Array.from(document.querySelectorAll('video')).filter(v => v.readyState > 0 || v.currentSrc || v.src);
    if (!vids.length) return 'none';
    const playing = vids.filter(v => !v.paused && !v.ended);
    const pool = playing.length ? playing : vids;
    pool.sort((a,b) => (b.clientWidth*b.clientHeight) - (a.clientWidth*a.clientHeight));
    const v = pool[0];
    if (v.disablePictureInPicture) v.disablePictureInPicture = false;
    if (typeof v.requestPictureInPicture === 'function') { v.requestPictureInPicture().catch(()=>{}); return 'enter'; }
    return 'unsupported';
  } catch (e) { return 'error'; }
})()`;

module.exports = { READERABLE_JS, EXTRACT_JS, PIP_JS };
