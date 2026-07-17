const GRAYSCALE_CSS = 'html { filter: grayscale(100%) !important; }';

function applyGrayscale(wc) {
    try {
        if (wc.grayscaleKey) return;
        wc.insertCSS(GRAYSCALE_CSS, { cssOrigin: 'user' }).then(key => {
            wc.grayscaleKey = key;
        });
    } catch {}
}

function removeGrayscale(wc) {
    try {
        if (wc.grayscaleKey) {
            wc.removeInsertedCSS(wc.grayscaleKey);
            wc.grayscaleKey = null;
        }
    } catch {}
}

export { applyGrayscale, removeGrayscale };