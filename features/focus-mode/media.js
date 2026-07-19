function pauseMedia(wc) {
    try {
        wc.executeJavaScript('document.querySelectorAll("video,audio").forEach(m => { try { m.pause(); } catch {} });');
    }
    catch { }
}

module.exports = { pauseMedia };