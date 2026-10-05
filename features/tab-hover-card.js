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

/* A picture of a BACKGROUND tab, as a native browser's hover card shows. The
   active tab is the page you are looking at, so it gets none; a slept or
   crashed tab has nothing to capture. capturePage works on a tab that is not
   on screen (even one opened in the background and never shown). Captures are
   cached per tab for a few seconds so moving along the strip stays instant. */
async function previewFor(wd, index) {
    const tab = wd.tabs?.tabMap?.get(index);
    const wc = tab?.webContents;
    if (!wc || wc.isDestroyed() || tab.slept || wc.isCrashed())
        return null;
    const url = wd.tabs.tabUrls?.get(index) || '';
    if (!/^https?:/i.test(url))
        return null;
    wd.hoverCardThumbs = wd.hoverCardThumbs || new Map();
    const hit = wd.hoverCardThumbs.get(index);
    if (hit && hit.url === url && Date.now() - hit.at < PREVIEW_FRESH)
        return hit.data;
    try {
        const img = await wc.capturePage();
        if (!img || img.isEmpty())
            return null;
        const { width } = img.getSize();
        const small = width > PREVIEW_W ? img.resize({ width: PREVIEW_W, quality: 'good' }) : img;
        const data = 'data:image/jpeg;base64,' + small.toJPEG(78).toString('base64');
        wd.hoverCardThumbs.set(index, { url, at: Date.now(), data });
        // A small cache: drop the oldest once it holds more than a strip's worth.
        if (wd.hoverCardThumbs.size > 24)
            wd.hoverCardThumbs.delete(wd.hoverCardThumbs.keys().next().value);
        return data;
    }
    catch (e) {
        log.debug('tab-hover-card', 'preview', e);
        return null;
    }
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

module.exports = { show, hide, place };
