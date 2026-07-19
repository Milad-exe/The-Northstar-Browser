const { applyGrayscale, removeGrayscale } = require('./grayscale');
const { pauseMedia } = require('./media');
const { getFocusInjectionForUrl, getShortformInjectionForUrl } = require('./injections');
class FocusMode {
    state; // keyed by window id
    shortformEnabled;
    constructor() {
        // keyed by window id -> { active: bool }
        this.state = new Map();
        this.shortformEnabled = false;
    }
    isActive(windowData) {
        return this.state.get(windowData.id)?.active ?? false;
    }
    setShortformEnabled(wm, enabled) {
        this.shortformEnabled = !!enabled;
        if (!wm || typeof wm.getAllWindows !== 'function')
            return;
        wm.getAllWindows().forEach(windowData => {
            if (!windowData?.tabs)
                return;
            if (this.isActive(windowData))
                return;
            if (this.shortformEnabled)
                this.applyShortformToAll(windowData);
            else
                this.clearShortformFromAll(windowData);
        });
    }
    enable(windowData) {
        this.state.set(windowData.id, { active: true });
        this.applyToAll(windowData, true);
        if (windowData.window && !windowData.window.isDestroyed()) {
            windowData.window.webContents.send('focus-mode-changed', true);
        }
    }
    disable(windowData) {
        this.state.set(windowData.id, { active: false });
        this.applyToAll(windowData, false);
        if (windowData.window && !windowData.window.isDestroyed()) {
            windowData.window.webContents.send('focus-mode-changed', false);
        }
    }
    toggle(windowData) {
        if (this.isActive(windowData)) {
            this.disable(windowData);
        }
        else {
            this.enable(windowData);
        }
    }
    // Called from Tabs when a new tab finishes loading
    applyToTab(windowData, tabWebContents, url) {
        if (this.isActive(windowData)) {
            this.applyGrayscale(tabWebContents);
            this.injectFocus(tabWebContents, url);
            return;
        }
        if (this.shortformEnabled) {
            this.injectShortform(tabWebContents, url);
        }
    }
    applyGrayscale(wc) {
        applyGrayscale(wc);
    }
    removeGrayscale(wc) {
        removeGrayscale(wc);
    }
    injectFocus(wc, url) {
        const js = getFocusInjectionForUrl(url || '');
        if (js) {
            try {
                wc.executeJavaScript(js);
            }
            catch { }
        }
    }
    injectShortform(wc, url) {
        const js = getShortformInjectionForUrl(url || '');
        if (js) {
            try {
                wc.executeJavaScript(js);
            }
            catch { }
        }
    }
    applyShortformToAll(windowData) {
        if (!windowData.tabs)
            return;
        windowData.tabs.tabMap.forEach((tab) => {
            if (!tab.webContents || tab.webContents.isDestroyed())
                return;
            const url = tab.webContents.getURL ? tab.webContents.getURL() : '';
            this.injectShortform(tab.webContents, url);
        });
    }
    clearShortformFromAll(windowData) {
        if (!windowData.tabs)
            return;
        windowData.tabs.tabMap.forEach((tab, index) => {
            if (!tab.webContents || tab.webContents.isDestroyed())
                return;
            const url = tab.webContents.getURL ? tab.webContents.getURL() : '';
            if (!getShortformInjectionForUrl(url))
                return;
            if (windowData.tabs.activeTabIndex === index) {
                tab.webContents.reload();
            }
            else {
                tab.needsReloadForShortform = true;
            }
        });
    }
    applyToAll(windowData, enable) {
        if (!windowData.tabs)
            return;
        windowData.tabs.tabMap.forEach((tab, index) => {
            if (!tab.webContents || tab.webContents.isDestroyed())
                return;
            if (enable) {
                this.applyGrayscale(tab.webContents);
                pauseMedia(tab.webContents);
                const url = tab.webContents.getURL ? tab.webContents.getURL() : '';
                this.injectFocus(tab.webContents, url);
                pauseMedia(tab.webContents);
                return;
            }
            this.removeGrayscale(tab.webContents);
            const url = tab.webContents.getURL ? tab.webContents.getURL() : '';
            const needsReload = !!getFocusInjectionForUrl(url);
            if (needsReload) {
                if (windowData.tabs.activeTabIndex === index) {
                    tab.webContents.reload();
                }
                else {
                    tab.needsReloadForFocusMode = true;
                }
                return;
            }
            if (this.shortformEnabled) {
                this.injectShortform(tab.webContents, url);
            }
        });
    }
}

module.exports = new FocusMode();