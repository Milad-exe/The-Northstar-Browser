'use strict';
/**
 * Tab hover card — the small card a tab shows when you rest the pointer on it:
 * the page's full title, its site, and anything worth knowing about the tab
 * (sleeping, crashed, playing audio, using the camera, private).
 *
 * It is its own WebContentsView (registered in overlay-registry.js, CLAUDE.md
 * invariant 4) because it has to be able to sit over the page card, which a
 * label drawn in the chrome document cannot do. One view per window, created
 * lazily and reused. The view is sized to the card exactly — a transparent
 * margin would still swallow clicks meant for the page underneath.
 *
 * Flow: the chrome sends the tab's rect and text (hovercard:show). The card
 * page lays itself out and reports its size; only then is the view placed and
 * shown, so it never flashes at the wrong size. Moving from tab to tab while a
 * card is up updates it in place, without replaying the entrance.
 */
const path = require('path');
const { WebContentsView } = require('electron');
const { resolveAppFile } = require('../app-paths');
const log = require('./log');
const { signalEnter, playOutThenHide } = require('./overlay-anim');

const GAP = 6;   // between the tab and the card
const EDGE = 8;  // keep this far from the window edges
const PREVIEW_W = 600;      // px: the card shows it at 300 CSS px, so 2x for HiDPI
const PREVIEW_FRESH = 4000; // ms a capture is reused while you move along the strip

/* Pictures of tabs, the way a native browser keeps them (Chromium's
   ThumbnailTabHelper):
   - taken the moment you switch AWAY from a tab (captureOnBackground), so a
     background tab always has the page as you left it;
   - KEPT when the tab sleeps or crashes. A slept tab has no renderer to
     capture, and it used to show no picture at all, which with tab sleep on
     by default meant most background tabs had none;
   - never bought by waking a tab: a slept tab is not reloaded for a preview;
   - saved, encrypted, on quit and read back on start, so the tabs a restored
     session brings back unloaded still show what they were (Chromium does not
     do this; it reloads them instead, which we never do).
   Private windows and private tabs are never captured or saved. */
const THUMB_MAX = 60;       // pictures kept per window, newest first
const SAVED_MAX = 60;       // pictures written to disk on quit
let saved = null;           // url → data URL, read once from disk
const thumbFile = () => path.join(require('electron').app.getPath('userData'), 'northstar', 'tab-thumbs.enc');
function savedThumbs() {
    if (saved) return saved;
    saved = new Map();
    try {
        const fs = require('fs');
        if (fs.existsSync(thumbFile())) {
            const { decrypt } = require('./encryption');
            for (const [u, d] of JSON.parse(decrypt(fs.readFileSync(thumbFile(), 'utf8'))))
                if (typeof u === 'string' && typeof d === 'string' && d.startsWith('data:image/jpeg;base64,'))
                    saved.set(u, d);
        }
    }
    catch (e) { log.warn('tab-hover-card', 'saved tab previews unreadable, starting without them', e); }
    return saved;
}
const isPrivate = (wd, index) => !!(wd?.tabs?.isPrivateWindow || wd?.tabs?.privateTabs?.has?.(index));
function remember(wd, index, url, data) {
    wd.hoverCardThumbs = wd.hoverCardThumbs || new Map();
    wd.hoverCardThumbs.delete(index); // re-insert: Map order is the recency order
    wd.hoverCardThumbs.set(index, { url, at: Date.now(), data });
    for (const k of [...wd.hoverCardThumbs.keys()]) {
        if (wd.hoverCardThumbs.size <= THUMB_MAX) break;
        if (!wd.tabs?.tabMap?.has(k) || wd.hoverCardThumbs.size > THUMB_MAX) wd.hoverCardThumbs.delete(k);
    }
}
async function capture(wd, index) {
    const tab = wd.tabs?.tabMap?.get(index);
    const wc = tab?.webContents;
    const url = wd.tabs?.tabUrls?.get(index) || '';
    if (!wc || wc.isDestroyed() || tab.slept || wc.isCrashed() || tab.lazyLoaded === false)
        return null;
    if (!/^https?:/i.test(url) || isPrivate(wd, index))
        return null;
    const img = await wc.capturePage();
    if (!img || img.isEmpty())
        return null;
    const { width } = img.getSize();
    const small = width > PREVIEW_W ? img.resize({ width: PREVIEW_W, quality: 'good' }) : img;
    const data = 'data:image/jpeg;base64,' + small.toJPEG(78).toString('base64');
    remember(wd, index, url, data);
    return data;
}
/** Picture the tab you just left (called on every tab switch). */
function captureOnBackground(wd, index) {
    if (!wd || !Number.isInteger(index) || index < 0)
        return;
    capture(wd, index).catch((e) => log.debug('tab-hover-card', 'capture on background', e));
}
/* The picture for a BACKGROUND tab's card. The active tab is the page you are
   looking at, so it gets none. A live background tab is re-captured when its
   picture is more than a few seconds old (pages change while hidden); a slept,
   crashed or not-yet-loaded tab shows the last picture it had. */
async function previewFor(wd, index) {
    if (isPrivate(wd, index))
        return null;
    const url = wd.tabs?.tabUrls?.get(index) || '';
    if (!/^https?:/i.test(url))
        return null;
    const hit = wd.hoverCardThumbs?.get(index);
    const last = (hit && hit.url === url) ? hit.data : (savedThumbs().get(url) || null);
    if (hit && hit.url === url && Date.now() - hit.at < PREVIEW_FRESH)
        return hit.data;
    try {
        return (await capture(wd, index)) || last;
    }
    catch (e) {
        log.debug('tab-hover-card', 'preview', e);
        return last;
    }
}
/** On quit: keep the pictures of the tabs a restored session will bring back. */
function saveThumbs(wm) {
    try {
        const out = new Map();
        for (const wd of wm.getAllWindows()) {
            if (wd.tabs?.isPrivateWindow) continue;
            for (const [index, t] of [...(wd.hoverCardThumbs || new Map())].reverse()) {
                if (out.size >= SAVED_MAX) break;
                if (!wd.tabs?.tabMap?.has(index) || isPrivate(wd, index) || out.has(t.url)) continue;
                out.set(t.url, t.data);
            }
        }
        // Tabs that never loaded this session keep the picture they came in with.
        for (const wd of wm.getAllWindows()) {
            if (wd.tabs?.isPrivateWindow) continue;
            for (const [index] of wd.tabs?.tabMap || []) {
                const u = wd.tabs.tabUrls?.get(index);
                if (out.size >= SAVED_MAX) break;
                if (u && !out.has(u) && !isPrivate(wd, index) && savedThumbs().has(u)) out.set(u, savedThumbs().get(u));
            }
        }
        const fs = require('fs');
        const { encrypt } = require('./encryption');
        fs.writeFileSync(thumbFile(), encrypt(JSON.stringify([...out])));
    }
    catch (e) { log.warn('tab-hover-card', 'could not save tab previews', e); }
}

async function ensureView(wd) {
    if (wd.hoverCard) {
        if (wd.hoverCardReady)
            await wd.hoverCardReady;
        return wd.hoverCard;
    }
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/tab-hover-card-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Hidden between hovers; it must still lay out and answer at once.
            backgroundThrottling: false,
        },
    });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    wd.hoverCard = view;
    wd.window.contentView.addChildView(view);
    view.webContents.loadFile(resolveAppFile('renderer/TabHoverCard/index.html'));
    wd.hoverCardReady = new Promise(res => view.webContents.once('did-finish-load', () => res()));
    await wd.hoverCardReady;
    return view;
}

/** Where the card goes for a tab at `rect` (chrome coordinates), `size` big. */
function place(wd, rect, size, side) {
    const area = wd.window.getContentBounds();
    const w = Math.ceil(size.width), h = Math.ceil(size.height);
    let x, y;
    if (side) {
        // Sidebar: to the right of the row, top-aligned with it.
        x = rect.right + GAP;
        y = rect.top;
    }
    else {
        // Top strip: under the tab, left-aligned with it.
        x = rect.left;
        y = rect.bottom + GAP;
    }
    x = Math.max(EDGE, Math.min(x, area.width - w - EDGE));
    y = Math.max(EDGE, Math.min(y, area.height - h - EDGE));
    return { x: Math.round(x), y: Math.round(y), width: w, height: h };
}

async function show(wd, data) {
    if (!wd || !data || !data.rect)
        return;
    // Never over an open menu: the card would cover the thing you are using.
    if (wd.ctxMenuOpen || wd.menuBarOpen)
        return;
    const seq = (wd.hoverCardSeq || 0) + 1;
    wd.hoverCardSeq = seq;
    try {
        const view = await ensureView(wd);
        if (wd.hoverCardSeq !== seq)
            return; // superseded while the view was loading
        if (!data.active && Number.isInteger(data.index)) {
            data = { ...data, preview: await previewFor(wd, data.index) };
            if (wd.hoverCardSeq !== seq)
                return;
        }
        const size = await new Promise((resolve) => {
            const onSize = (_e, s) => { if (s && s.seq === seq) { view.webContents.ipc.removeListener('hovercard:size', onSize); resolve(s); } };
            view.webContents.ipc.on('hovercard:size', onSize);
            view.webContents.send('hovercard:data', { ...data, seq });
            setTimeout(() => { view.webContents.ipc.removeListener('hovercard:size', onSize); resolve(null); }, 400);
        });
        if (!size) {
            log.warn('tab-hover-card', 'the card did not report its size; not shown');
            return;
        }
        if (wd.hoverCardSeq !== seq)
            return;
        view.setBounds(place(wd, data.rect, size, !!data.side));
        const wasOpen = wd.hoverCardOpen;
        if (!wasOpen) {
            // Raise above the page views (they are re-added on tab switches).
            try {
                wd.window.contentView.removeChildView(view);
                wd.window.contentView.addChildView(view);
            }
            catch (e) { log.debug('tab-hover-card', 'raise', e); }
            view.setVisible(true);
            wd.hoverCardOpen = true;
            signalEnter(view);
        }
    }
    catch (e) { log.warn('tab-hover-card', 'show', e); }
}

function hide(wd) {
    if (!wd)
        return;
    wd.hoverCardSeq = (wd.hoverCardSeq || 0) + 1; // cancel a show in flight
    if (!wd.hoverCard || !wd.hoverCardOpen)
        return;
    wd.hoverCardOpen = false;
    playOutThenHide(wd.hoverCard);
}

module.exports = { show, hide, place, captureOnBackground, saveThumbs };
