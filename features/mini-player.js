'use strict';
/**
 * Mini media player — floating overlay shown when media is playing in a tab
 * the user is not looking at (like a browser's global media controls). Rendered
 * as a WebContentsView so it draws above the page; controls the source tab via
 * executeJavaScript (play/pause, position) and audioMuted (mute).
 *
 * Lifecycle: appears when a background tab starts playing, or when the user
 * switches away from a playing tab. Disappears when the user returns to the
 * media tab, dismisses it (until a different tab plays), or the tab closes.
 * Toggleable in Settings → General ("miniPlayerEnabled").
 */
const log = require('./log');
const { PANEL_RADIUS } = require('./overlay-bounds');
const path = require('path');
const { resolveAppFile } = require('../app-paths');
const { WebContentsView, webContents } = require('electron');
// One full-width bar, floating over the page. The margin is the shell's own
// gutter doubled (--sp-6), not a number of its own.
const BAR_MAXW = 760, BAR_H = 84, MARGIN = 16;
// executeJavaScript on a tab whose render frame is mid-navigation (being
// disposed) throws "Render frame was disposed before WebFrameMain could be
// accessed" — Electron logs it to the console even when the promise rejection is
// caught. Only run script when the main frame is actually reachable.
function canRunJs(wc) {
    try {
        if (!wc || wc.isDestroyed() || wc.isCrashed())
            return false;
        const f = wc.mainFrame;
        // Touching a property of a disposed WebFrameMain throws; a live frame has
        // a numeric routingId.
        return !!f && typeof f.routingId === 'number';
    }
    catch (e) { return false; }
}
// Reads playback state from the page. Prefers MediaSession metadata (YouTube,
// Spotify, SoundCloud all set it) and falls back to the document title.
const READ_STATE_JS = `(() => {
  try {
    const els = [...document.querySelectorAll('video,audio')].filter(m => (m.duration || 0) > 0 || !m.paused);
    const m = els.find(x => !x.paused) || els[0];
    const md = (navigator.mediaSession && navigator.mediaSession.metadata) || null;
    if (!m && !md) return null;
    return {
      title:  (md && md.title)  || document.title || '',
      artist: (md && md.artist) || '',
      art:    (md && md.artwork && md.artwork.length ? (md.artwork[0].src || null) : null),
      cur:    m ? (m.currentTime || 0) : 0,
      dur:    (m && m.duration && isFinite(m.duration)) ? m.duration : 0,
      vol:    m ? (typeof m.volume === 'number' ? m.volume : 1) : 1,
      paused: m ? m.paused : false,
    };
  } catch { return null; }
})()`;
// frac / vol are numbers injected after validation (never user strings).
const SEEK_JS = (frac) => `(() => {
  try {
    const els = [...document.querySelectorAll('video,audio')].filter(m => (m.duration || 0) > 0 || !m.paused);
    const m = els.find(x => !x.paused) || els[0];
    if (m && m.duration && isFinite(m.duration)) m.currentTime = ${frac} * m.duration;
    return true;
  } catch { return false; }
})()`;
const VOLUME_JS = (vol) => `(() => {
  try {
    [...document.querySelectorAll('video,audio')].forEach(m => { m.volume = ${vol}; });
    return true;
  } catch { return false; }
})()`;
const TOGGLE_JS = `(() => {
  try {
    const els = [...document.querySelectorAll('video,audio')].filter(m => (m.duration || 0) > 0 || !m.paused);
    const playing = els.filter(m => !m.paused);
    if (playing.length) { playing.forEach(m => m.pause()); return 'paused'; }
    if (els[0]) { els[0].play().catch(() => {}); return 'playing'; }
    return 'none';
  } catch { return 'err'; }
})()`;
function panelBounds(wd) {
    const b = wd.window.getBounds();
    const w = Math.min(BAR_MAXW, b.width - 2 * MARGIN);
    return { x: Math.max(0, Math.round((b.width - w) / 2)), y: Math.max(0, b.height - BAR_H - MARGIN), width: w, height: BAR_H };
}
function isEnabled(wd) {
    try {
        return wd.tabs?.persistence?.get('miniPlayerEnabled') !== false;
    }
    catch {
        return true;
    }
}
function liveTab(wd, index) {
    const tab = index == null ? null : wd.tabs?.tabMap.get(index);
    return tab && tab.webContents && !tab.webContents.isDestroyed() ? tab : null;
}
function show(wd, tabIndex) {
    if (!wd || wd.window.isDestroyed() || !isEnabled(wd))
        return;
    if (wd.miniPlayerDismissedFor === tabIndex)
        return;
    if (!liveTab(wd, tabIndex))
        return; // never bind to a closed/dying tab
    if (wd.miniPlayer) {
        // Panel already up: another tab may NOT steal the binding while the
        // bound tab is still alive and playing — otherwise closing the bound
        // tab compares against the thief's index and the panel outlives it.
        const cur = liveTab(wd, wd.miniPlayerTab);
        if (cur && cur.hasPlayingMedia && wd.miniPlayerTab !== tabIndex)
            return;
        wd.miniPlayerTab = tabIndex;
        pushState(wd);
        return;
    }
    wd.miniPlayerTab = tabIndex;
    /* The panel is a pointer surface: it must never take keyboard focus from
       what you were doing. A fresh WebContentsView grabs focus as its page
       loads, and a click on one of its buttons focuses it too, so whatever
       had focus (the page you switched to, or the address bar) lost it and
       your next keystroke went nowhere. Hand focus straight back. */
    const before = webContents.getFocusedWebContents();
    const giveBack = (toBefore) => {
        try {
            // On first appearance, back to exactly what had focus; after a click
            // on the panel, to the page you are looking at (the tab that had
            // focus back then may be a background tab by now).
            const active = wd.tabs?.tabMap?.get(wd.tabs.activeTabIndex)?.webContents;
            const target = (toBefore && before && !before.isDestroyed() && before !== view.webContents) ? before : active;
            if (target && !target.isDestroyed() && view.webContents.isFocused())
                target.focus();
        }
        catch (e) { log.debug('mini-player', 'give focus back', e); }
    };
    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/miniplayer-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    view.setBackgroundColor('#00000000');
    try { view.setBorderRadius(PANEL_RADIUS); } catch (e) { log.debug('mini-player', 'if', e); }
    wd.window.contentView.addChildView(view);
    view.webContents.loadFile(resolveAppFile('renderer/MiniPlayer/index.html'));
    view.setBounds(panelBounds(wd));
    wd.miniPlayer = view;
    const onResize = () => { try {
        view.setBounds(panelBounds(wd));
    }
    catch (e) { log.debug('mini-player', 'onResize', e); } };
    wd.window.on('resize', onResize);
    const poll = setInterval(() => pushState(wd), 1000);
    wd.miniPlayerCleanup = () => {
        try {
            wd.window.removeListener('resize', onResize);
        }
        catch (e) { log.debug('mini-player', 'onResize', e); }
        clearInterval(poll);
    };
    view.webContents.once('did-finish-load', () => { pushState(wd); giveBack(true); });
    view.webContents.on('focus', () => setImmediate(() => giveBack(false)));
}
function hide(wd) {
    if (!wd || !wd.miniPlayer)
        return;
    try {
        wd.miniPlayerCleanup?.();
    }
    catch (e) { log.debug('mini-player', 'hide', e); }
    wd.miniPlayerCleanup = null;
    try {
        wd.window.contentView.removeChildView(wd.miniPlayer);
    }
    catch (e) { log.debug('mini-player', 'hide', e); }
    try {
        wd.miniPlayer.webContents.close?.();
    }
    catch (e) { log.debug('mini-player', 'hide', e); }
    wd.miniPlayer = null;
    wd.miniPlayerTab = null;
}
// Show only for playback the user can actually hear (or has deliberately tab-
// muted). Muted autoplay — ads, hero banners, preview thumbnails — fires
// media-started-playing too and must not pop the panel. Audibility needs a
// beat to settle after playback starts, hence the delayed check.
function showIfAudible(wd, index) {
    setTimeout(() => {
        try {
            const tab = liveTab(wd, index);
            if (!tab || !tab.hasPlayingMedia)
                return;
            if (!wd.tabs || index === wd.tabs.activeTabIndex)
                return;
            if (!tab.webContents.isCurrentlyAudible() && !tab.webContents.audioMuted)
                return;
            show(wd, index);
        }
        catch (e) { log.debug('mini-player', 'showIfAudible', e); }
    }, 300);
}
async function pushState(wd) {
    if (!wd || !wd.miniPlayer || wd.miniPlayerTab == null)
        return;
    const tab = wd.tabs?.tabMap.get(wd.miniPlayerTab);
    if (!tab || !tab.webContents || tab.webContents.isDestroyed()) {
        hide(wd);
        return;
    }
    let s = null;
    if (canRunJs(tab.webContents)) {
        try {
            s = await tab.webContents.executeJavaScript(READ_STATE_JS, true);
        }
        catch (e) { log.debug('mini-player', 'pushState', e); }
    }
    if (!s) {
        // No media element or session left on the bound tab (it navigated away,
        // or the media ended and was removed) and nothing is audible — the panel
        // has nothing left to control, so dismiss it. The poll (or a fresh media
        // event) reopens it if audio starts again. Fixes the panel lingering
        // after leaving a media page.
        let audible = false;
        try { audible = tab.webContents.isCurrentlyAudible(); } catch (e) { log.debug('mini-player', 'if', e); }
        if (!tab.hasPlayingMedia && !audible) {
            hide(wd);
            return;
        }
        let title = '';
        try {
            title = tab.webContents.getTitle() || '';
        }
        catch (e) { log.debug('mini-player', 'if', e); }
        s = { title, artist: '', cur: 0, dur: 0, paused: !tab.hasPlayingMedia };
    }
    s.muted = !!tab.webContents.audioMuted;
    try {
        wd.miniPlayer.webContents.send('mp-state', s);
    }
    catch (e) { log.debug('mini-player', 'if', e); }
}
// ── Hooks called by the tab manager ───────────────────────────────────────────
function onMediaState(wd, index, playing) {
    if (!wd || !wd.tabs)
        return;
    if (playing && index !== wd.tabs.activeTabIndex) {
        // A different tab starting playback clears an earlier dismissal.
        if (wd.miniPlayerDismissedFor !== undefined && wd.miniPlayerDismissedFor !== index) {
            wd.miniPlayerDismissedFor = undefined;
        }
        showIfAudible(wd, index);
    }
    else if (!playing && wd.miniPlayer && wd.miniPlayerTab === index) {
        pushState(wd); // reflect the paused state; keep the panel up
    }
}
function onTabSwitch(wd, prevIndex, newIndex) {
    if (!wd)
        return;
    if (wd.miniPlayer && wd.miniPlayerTab === newIndex)
        hide(wd); // arrived at the media tab
    const prev = liveTab(wd, prevIndex);
    if (prev && prev.hasPlayingMedia && prevIndex !== newIndex && wd.miniPlayerDismissedFor !== prevIndex) {
        showIfAudible(wd, prevIndex); // walked away from a playing tab
    }
}
function onTabClosed(wd, index) {
    if (!wd)
        return;
    if (wd.miniPlayer && wd.miniPlayerTab === index)
        hide(wd);
    if (wd.miniPlayerDismissedFor === index)
        wd.miniPlayerDismissedFor = undefined;
}
// ── Panel actions (via ipc/mini-player.js) ────────────────────────────────────
async function action(wd, act, value) {
    if (!wd || wd.miniPlayerTab == null)
        return;
    const tab = wd.tabs?.tabMap.get(wd.miniPlayerTab);
    if (!tab)
        return;
    if (act === 'toggle') {
        if (canRunJs(tab.webContents)) {
            try {
                await tab.webContents.executeJavaScript(TOGGLE_JS, true);
            }
            catch (e) { log.debug('mini-player', 'if', e); }
        }
        pushState(wd);
    }
    else if (act === 'mute') {
        try {
            tab.webContents.audioMuted = !tab.webContents.audioMuted;
        }
        catch (e) { log.debug('mini-player', 'if', e); }
        pushState(wd);
    }
    else if (act === 'seek') {
        const frac = Math.max(0, Math.min(1, Number(value) || 0));
        if (canRunJs(tab.webContents)) {
            try {
                await tab.webContents.executeJavaScript(SEEK_JS(frac), true);
            }
            catch (e) { log.debug('mini-player', 'if', e); }
        }
        pushState(wd);
    }
    else if (act === 'volume') {
        const vol = Math.max(0, Math.min(1, Number(value) || 0));
        if (canRunJs(tab.webContents)) {
            try {
                await tab.webContents.executeJavaScript(VOLUME_JS(vol), true);
            }
            catch (e) { log.debug('mini-player', 'if', e); }
        }
        pushState(wd);
    }
    else if (act === 'goto') {
        const t = wd.miniPlayerTab;
        hide(wd);
        try {
            wd.tabs.showTab(t);
        }
        catch (e) { log.debug('mini-player', 'if', e); }
    }
    else if (act === 'close') {
        wd.miniPlayerDismissedFor = wd.miniPlayerTab;
        hide(wd);
    }
}

module.exports = { onMediaState, onTabSwitch, onTabClosed, action, hide, pushState };