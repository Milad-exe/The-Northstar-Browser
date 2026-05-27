'use strict';

// Skip our own renderer pages
if (location.protocol === 'file:') return;

// Preload scripts run in an isolated world — prototype patches here don't affect
// the page's world.  Injecting a <script> tag is the standard way to reach world 0.
const PATCH = `(function () {
    if (window.__inkPrivH) return;
    window.__inkPrivH = true;

    // ── Canvas fingerprint noise ──────────────────────────────────────────────
    var _gi = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (sx, sy, sw, sh) {
        var d = _gi.call(this, sx, sy, sw, sh);
        var a = d.data;
        for (var i = 0; i < a.length; i += 4) {
            a[i]   = Math.max(0, Math.min(255, a[i]   + ((Math.random() * 2 - 1) | 0)));
            a[i+1] = Math.max(0, Math.min(255, a[i+1] + ((Math.random() * 2 - 1) | 0)));
            a[i+2] = Math.max(0, Math.min(255, a[i+2] + ((Math.random() * 2 - 1) | 0)));
        }
        return d;
    };

    // ── Navigator normalization ───────────────────────────────────────────────
    try {
        Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: function () { return 4; }, configurable: true });
        Object.defineProperty(Navigator.prototype, 'deviceMemory',        { get: function () { return 8; }, configurable: true });
        Object.defineProperty(Navigator.prototype, 'languages',           { get: function () { return Object.freeze(['en-US', 'en']); }, configurable: true });
        Object.defineProperty(Navigator.prototype, 'connection',          { get: function () { return undefined; }, configurable: true });
        Object.defineProperty(Navigator.prototype, 'mozConnection',       { get: function () { return undefined; }, configurable: true });
        Object.defineProperty(Navigator.prototype, 'webkitConnection',    { get: function () { return undefined; }, configurable: true });
    } catch (e) {}

    // ── Block media device enumeration ────────────────────────────────────────
    // enumerateDevices() reveals number/types of cameras and microphones — a
    // stable fingerprinting signal.
    try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            Object.defineProperty(navigator.mediaDevices, 'enumerateDevices', {
                value: function () { return Promise.resolve([]); },
                configurable: true, writable: true
            });
        }
    } catch (e) {}

    // ── WebRTC IP leak — JS-level defence-in-depth ────────────────────────────
    // Session-level setWebRTCIPHandlingPolicy is the primary block; this clears
    // STUN/TURN servers as a secondary layer.
    try {
        var _RTC = window.RTCPeerConnection;
        if (_RTC) {
            var PatchedRTC = function (cfg, constraints) {
                if (cfg && cfg.iceServers) cfg = Object.assign({}, cfg, { iceServers: [] });
                return new _RTC(cfg, constraints);
            };
            PatchedRTC.prototype = _RTC.prototype;
            window.RTCPeerConnection = PatchedRTC;
        }
    } catch (e) {}
})();`;

const s = document.createElement('script');
s.textContent = PATCH;
(document.documentElement || document.head || document.body).appendChild(s);
s.remove();
