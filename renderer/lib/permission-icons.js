/**
 * Permission glyphs (Phosphor), shared by the permission doorhanger
 * (renderer/PermissionPrompt) and the chrome's permission chip in the address
 * field (chrome-ux P2-2), so a request looks the same in both places.
 * Keyed by the iconType features/permission-prompt.js sends. UMD like util.js.
 */
(function (root, factory) {
    'use strict';
    const api = factory();
    if (typeof module === 'object' && module.exports)
        module.exports = api;
    root.Northstar = root.Northstar || {};
    root.Northstar.permissionIcons = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    // What the chip calls each permission when it confirms a decision.
    const NOUNS = { camera: 'Camera', microphone: 'Microphone', location: 'Location', notifications: 'Notifications', screen: 'Screen sharing', clipboard: 'Clipboard', midi: 'MIDI devices', external: 'Opening apps', generic: 'Permission' };
    /** "Camera allowed" / "Microphone blocked" — English; the chrome localises
     *  through perm.allowed / perm.blocked with {name}. */
    function chipText(iconType, allowed) {
        return `${NOUNS[iconType] || NOUNS.generic} ${allowed ? 'allowed' : 'blocked'}`;
    }
    const ICONS = {
        camera: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M249.45,69.31a12,12,0,0,0-12.51,1L212,88.43V72a20,20,0,0,0-20-20H32A20,20,0,0,0,12,72V184a20,20,0,0,0,20,20H192a20,20,0,0,0,20-20V167.57l24.94,18.14A12,12,0,0,0,256,176V80A12,12,0,0,0,249.45,69.31ZM188,180H36V76H188Zm44-27.57-20-14.54V118.11l20-14.54Z"/></svg>`,
        microphone: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,180a52.06,52.06,0,0,0,52-52V64A52,52,0,0,0,76,64v64A52.06,52.06,0,0,0,128,180ZM100,64a28,28,0,0,1,56,0v64a28,28,0,0,1-56,0Zm40,155.22V240a12,12,0,0,1-24,0V219.22A92.14,92.14,0,0,1,36,128a12,12,0,0,1,24,0,68,68,0,0,0,136,0,12,12,0,0,1,24,0A92.14,92.14,0,0,1,140,219.22Z"/></svg>`,
        location: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M128,60a44,44,0,1,0,44,44A44.05,44.05,0,0,0,128,60Zm0,64a20,20,0,1,1,20-20A20,20,0,0,1,128,124Zm0-112a92.1,92.1,0,0,0-92,92c0,77.36,81.64,135.4,85.12,137.83a12,12,0,0,0,13.76,0,259,259,0,0,0,42.18-39C205.15,170.57,220,136.37,220,104A92.1,92.1,0,0,0,128,12Zm31.3,174.71A249.35,249.35,0,0,1,128,216.89a249.35,249.35,0,0,1-31.3-30.18C80,167.37,60,137.31,60,104a68,68,0,0,1,136,0C196,137.31,176,167.37,159.3,186.71Z"/></svg>`,
        notifications: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M225.29,165.93C216.61,151,212,129.57,212,104a84,84,0,0,0-168,0c0,25.58-4.59,47-13.27,61.93A20.08,20.08,0,0,0,30.66,186,19.77,19.77,0,0,0,48,196H84.18a44,44,0,0,0,87.64,0H208a19.77,19.77,0,0,0,17.31-10A20.08,20.08,0,0,0,225.29,165.93ZM128,212a20,20,0,0,1-19.6-16h39.2A20,20,0,0,1,128,212ZM54.66,172C63.51,154,68,131.14,68,104a60,60,0,0,1,120,0c0,27.13,4.48,50,13.33,68Z"/></svg>`,
        screen: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,36H48A28,28,0,0,0,20,64V176a28,28,0,0,0,28,28H208a28,28,0,0,0,28-28V64A28,28,0,0,0,208,36Zm4,140a4,4,0,0,1-4,4H48a4,4,0,0,1-4-4V64a4,4,0,0,1,4-4H208a4,4,0,0,1,4,4Zm-40,52a12,12,0,0,1-12,12H96a12,12,0,0,1,0-24h64A12,12,0,0,1,172,228Z"/></svg>`,
        clipboard: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M172,164a12,12,0,0,1-12,12H96a12,12,0,0,1,0-24h64A12,12,0,0,1,172,164Zm-12-52H96a12,12,0,0,0,0,24h64a12,12,0,0,0,0-24Zm60-64V216a20,20,0,0,1-20,20H56a20,20,0,0,1-20-20V48A20,20,0,0,1,56,28H90.53a51.88,51.88,0,0,1,74.94,0H200A20,20,0,0,1,220,48ZM100.29,60h55.42a28,28,0,0,0-55.42,0ZM196,52H178.59A52.13,52.13,0,0,1,180,64v8a12,12,0,0,1-12,12H88A12,12,0,0,1,76,72V64a52.13,52.13,0,0,1,1.41-12H60V212H196Z"/></svg>`,
        midi: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,28H48A20,20,0,0,0,28,48V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V48A20,20,0,0,0,208,28ZM92,132V52h24v80Zm52,24v48H112V156Zm20-24H140V52h24ZM52,52H68v92a12,12,0,0,0,12,12h8v48H52ZM204,204H168V156h8a12,12,0,0,0,12-12V52h16Z"/></svg>`,
        external: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M228,104a12,12,0,0,1-24,0V69l-59.51,59.51a12,12,0,0,1-17-17L187,52H152a12,12,0,0,1,0-24h64a12,12,0,0,1,12,12Zm-44,24a12,12,0,0,0-12,12v64H52V84h64a12,12,0,0,0,0-24H48A20,20,0,0,0,28,80V208a20,20,0,0,0,20,20H176a20,20,0,0,0,20-20V140A12,12,0,0,0,184,128Z"/></svg>`,
        shield: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,36H48A20,20,0,0,0,28,56v56c0,54.29,26.32,87.22,48.4,105.29,23.71,19.39,47.44,26,48.44,26.29a12.1,12.1,0,0,0,6.32,0c1-.28,24.73-6.9,48.44-26.29,22.08-18.07,48.4-51,48.4-105.29V56A20,20,0,0,0,208,36Zm-4,76c0,35.71-13.09,64.69-38.91,86.15A126.28,126.28,0,0,1,128,219.38a126.14,126.14,0,0,1-37.09-21.23C65.09,176.69,52,147.71,52,112V60H204ZM79.51,144.49a12,12,0,1,1,17-17L112,143l47.51-47.52a12,12,0,0,1,17,17l-56,56a12,12,0,0,1-17,0Z"/></svg>`,
        generic: `<svg viewBox="0 0 256 256" fill="currentColor" aria-hidden="true"><path d="M208,76H180V56A52,52,0,0,0,76,56V76H48A20,20,0,0,0,28,96V208a20,20,0,0,0,20,20H208a20,20,0,0,0,20-20V96A20,20,0,0,0,208,76ZM100,56a28,28,0,0,1,56,0V76H100ZM204,204H52V100H204Z"/></svg>`,

    };
    return Object.assign({}, ICONS, { chipText, NOUNS });
});
