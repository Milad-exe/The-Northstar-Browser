'use strict';
/**
 * Mini media player — floating overlay shown when media is playing in a tab
 * the user is not looking at (like Chrome's global media controls). Rendered
 * as a WebContentsView so it draws above the page; controls the source tab via
 * executeJavaScript (play/pause, position) and audioMuted (mute).
 *
 * Lifecycle: appears when a background tab starts playing, or when the user
 * switches away from a playing tab. Disappears when the user returns to the
 * media tab, dismisses it (until a different tab plays), or the tab closes.
 * Toggleable in Settings → General ("miniPlayerEnabled").
 */

const path = require('path');
const { WebContentsView } = require('electron');

const BAR_MAXW = 760, BAR_H = 84, MARGIN = 14;   // single full-width bar

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
    try { return wd.tabs?.persistence?.get('miniPlayerEnabled') !== false; } catch { return true; }
}

function liveTab(wd, index) {
    const tab = index == null ? null : wd.tabs?.tabMap.get(index);
    return tab && tab.webContents && !tab.webContents.isDestroyed() ? tab : null;
}

function show(wd, tabIndex) {
    if (!wd || wd.window.isDestroyed() || !isEnabled(wd)) return;
    if (wd.miniPlayerDismissedFor === tabIndex) return;
    if (!liveTab(wd, tabIndex)) return;   // never bind to a closed/dying tab
    if (wd.miniPlayer) {
        // Panel already up: another tab may NOT steal the binding while the
        // bound tab is still alive and playing — otherwise closing the bound
        // tab compares against the thief's index and the panel outlives it.
        const cur = liveTab(wd, wd.miniPlayerTab);
        if (cur && cur.hasPlayingMedia && wd.miniPlayerTab !== tabIndex) return;
        wd.miniPlayerTab = tabIndex;
        pushState(wd);
        return;
    }
    wd.miniPlayerTab = tabIndex;

    const view = new WebContentsView({
        webPreferences: {
            preload: path.join(__dirname, '../preload/miniplayer-preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    view.setBackgroundColor('#00000000');
    wd.window.contentView.addChildView(view);
    view.webContents.loadFile('renderer/MiniPlayer/index.html');
    view.setBounds(panelBounds(wd));
    wd.miniPlayer = view;

    const onResize = () => { try { view.setBounds(panelBounds(wd)); } catch {} };
    wd.window.on('resize', onResize);
    const poll = setInterval(() => pushState(wd), 1000);
    wd.miniPlayerCleanup = () => {
        try { wd.window.removeListener('resize', onResize); } catch {}
        clearInterval(poll);
    };
    view.webContents.once('did-finish-load', () => pushState(wd));
}

function hide(wd) {
    if (!wd || !wd.miniPlayer) return;
    try { wd.miniPlayerCleanup?.(); } catch {}
    wd.miniPlayerCleanup = null;
    try { wd.window.contentView.removeChildView(wd.miniPlayer); } catch {}
    try { wd.miniPlayer.webContents.close?.(); } catch {}
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
            if (!tab || !tab.hasPlayingMedia) return;
            if (!wd.tabs || index === wd.tabs.activeTabIndex) return;
            if (!tab.webContents.isCurrentlyAudible() && !tab.webContents.audioMuted) return;
            show(wd, index);
        } catch {}
    }, 300);
}

async function pushState(wd) {
    if (!wd || !wd.miniPlayer || wd.miniPlayerTab == null) return;
    const tab = wd.tabs?.tabMap.get(wd.miniPlayerTab);
    if (!tab || !tab.webContents || tab.webContents.isDestroyed()) { hide(wd); return; }
    let s = null;
    try { s = await tab.webContents.executeJavaScript(READ_STATE_JS, true); } catch {}
    if (!s) {
        let title = ''; try { title = tab.webContents.getTitle() || ''; } catch {}
        s = { title, artist: '', cur: 0, dur: 0, paused: !tab.hasPlayingMedia };
    }
    s.muted = !!tab.webContents.audioMuted;
    try { wd.miniPlayer.webContents.send('mp-state', s); } catch {}
}

// ── Hooks called by the tab manager ───────────────────────────────────────────

function onMediaState(wd, index, playing) {
    if (!wd || !wd.tabs) return;
    if (playing && index !== wd.tabs.activeTabIndex) {
        // A different tab starting playback clears an earlier dismissal.
        if (wd.miniPlayerDismissedFor !== undefined && wd.miniPlayerDismissedFor !== index) {
            wd.miniPlayerDismissedFor = undefined;
        }
        showIfAudible(wd, index);
    } else if (!playing && wd.miniPlayer && wd.miniPlayerTab === index) {
        pushState(wd); // reflect the paused state; keep the panel up
    }
}

function onTabSwitch(wd, prevIndex, newIndex) {
    if (!wd) return;
    if (wd.miniPlayer && wd.miniPlayerTab === newIndex) hide(wd); // arrived at the media tab
    const prev = liveTab(wd, prevIndex);
    if (prev && prev.hasPlayingMedia && prevIndex !== newIndex && wd.miniPlayerDismissedFor !== prevIndex) {
        showIfAudible(wd, prevIndex); // walked away from a playing tab
    }
}

function onTabClosed(wd, index) {
    if (!wd) return;
    if (wd.miniPlayer && wd.miniPlayerTab === index) hide(wd);
    if (wd.miniPlayerDismissedFor === index) wd.miniPlayerDismissedFor = undefined;
}

// ── Panel actions (via ipc/mini-player.js) ────────────────────────────────────

async function action(wd, act, value) {
    if (!wd || wd.miniPlayerTab == null) return;
    const tab = wd.tabs?.tabMap.get(wd.miniPlayerTab);
    if (!tab) return;
    if (act === 'toggle') {
        try { await tab.webContents.executeJavaScript(TOGGLE_JS, true); } catch {}
        pushState(wd);
    } else if (act === 'mute') {
        try { tab.webContents.audioMuted = !tab.webContents.audioMuted; } catch {}
        pushState(wd);
    } else if (act === 'seek') {
        const frac = Math.max(0, Math.min(1, Number(value) || 0));
        try { await tab.webContents.executeJavaScript(SEEK_JS(frac), true); } catch {}
        pushState(wd);
    } else if (act === 'volume') {
        const vol = Math.max(0, Math.min(1, Number(value) || 0));
        try { await tab.webContents.executeJavaScript(VOLUME_JS(vol), true); } catch {}
        pushState(wd);
    } else if (act === 'goto') {
        const t = wd.miniPlayerTab;
        hide(wd);
        try { wd.tabs.showTab(t); } catch {}
    } else if (act === 'close') {
        wd.miniPlayerDismissedFor = wd.miniPlayerTab;
        hide(wd);
    }
}

module.exports = { onMediaState, onTabSwitch, onTabClosed, action, hide, pushState };
