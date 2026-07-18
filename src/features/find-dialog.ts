import { BrowserWindow, ipcMain } from 'electron';
import { resolveAppFile } from '../app-paths';
import path from 'path';
class FindDialogManager {
    dialogs: Map<number, FindDialog>;   // parentWindow webContents id → dialog
    static instance: FindDialogManager | null;

    constructor() {
        this.dialogs = new Map();
        this.setupGlobalIPC();
    }

    static getInstance() {
        if (!FindDialogManager.instance) {
            FindDialogManager.instance = new FindDialogManager();
        }
        return FindDialogManager.instance;
    }

    createDialog(parentWindow) {
        const windowId = parentWindow.webContents.id;
        if (!this.dialogs.has(windowId)) {
            this.dialogs.set(windowId, new FindDialog(parentWindow, this));
        }
        return this.dialogs.get(windowId);
    }

    removeDialog(windowId) {
        this.dialogs.delete(windowId);
    }

    setupGlobalIPC() {
        ipcMain.handle('find-search', (event, searchTerm) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handleSearch(searchTerm);
            }
        });

        ipcMain.handle('find-next', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handleNext();
            }
        });

        ipcMain.handle('find-previous', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handlePrevious();
            }
        });

        ipcMain.handle('find-clear', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.handleClear();
            }
        });

        ipcMain.handle('find-close', (event) => {
            const dialog = this.getDialogForEvent(event);
            if (dialog) {
                dialog.close();
            }
        });
    }

    getDialogForEvent(event) {
        for (const [windowId, dialog] of this.dialogs) {
            if (dialog.findWindow && dialog.findWindow.webContents === event.sender) {
                return dialog;
            }
        }
        return null;
    }
}

class FindDialog {
    manager: FindDialogManager;
    parentWindow: any;              // BrowserWindow the dialog floats over
    parentWindowId: number;         // that window's webContents id
    findWindow: any;                // the frameless dialog BrowserWindow
    activeTab: any;                 // TabView the search runs in
    currentSearchTerm: string;
    isDestroyed: boolean;

    constructor(parentWindow, manager) {
        this.parentWindow = parentWindow;
        this.manager = manager;
        this.findWindow = null;
        this.activeTab = null;
        this.currentSearchTerm = '';
        this.parentWindowId = parentWindow.webContents.id;
        this.isDestroyed = false;
        
        this.parentWindow.on('closed', () => {
            this.isDestroyed = true;
            this.cleanup();
            this.manager.removeDialog(this.parentWindowId);
        });
    }

    cleanup() {
        if (this.findWindow && !this.findWindow.isDestroyed()) {
            this.findWindow.close();
        }
        this.findWindow = null;
        this.activeTab = null;
        this.parentWindow = null;
    }

    show(activeTab) {
        if (this.isDestroyed) return;
        
        this.activeTab = activeTab;
        
        if (this.findWindow) {
            this.findWindow.focus();
            return;
        }

        this.findWindow = new BrowserWindow({
            width: 270,
            height: 110,
            frame: false,
            alwaysOnTop: true,
            resizable: false,
            transparent: true,
            skipTaskbar: true,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, '../preload/find-preload.js')
            }
        });

        this.findWindow.loadFile(resolveAppFile('renderer/FindDialog/index.html'));

        if (!this.isDestroyed && this.parentWindow && !this.parentWindow.isDestroyed()) {
            const parentBounds = this.parentWindow.getBounds();
            const x = parentBounds.x + parentBounds.width - 300;
            const y = parentBounds.y + 60;
            this.findWindow.setPosition(x, y);
        }

        this.findWindow.on('closed', () => {
            this.findWindow = null;
            if (this.activeTab && !this.activeTab.webContents.isDestroyed()) {
                this.activeTab.webContents.stopFindInPage('clearSelection');
            }
        });

        this.findWindow.webContents.on('before-input-event', (event, input) => {
            if (input.key === 'Escape' && input.type === 'keyDown') {
                this.close();
                event.preventDefault();
            }
        });
    }

    close() {
        if (this.findWindow && !this.findWindow.isDestroyed()) {
            this.findWindow.close();
        }
    }

    handleSearch(searchTerm) {
        if (this.isDestroyed) return;
        this.currentSearchTerm = searchTerm;
        if (this.activeTab && searchTerm && !this.activeTab.webContents.isDestroyed()) {
            this.activeTab.webContents.findInPage(searchTerm, { findNext: false });
        }
    }

    handleNext() {
        if (this.isDestroyed) return;
        if (this.activeTab && this.currentSearchTerm && !this.activeTab.webContents.isDestroyed()) {
            this.activeTab.webContents.findInPage(this.currentSearchTerm, { findNext: true });
        }
    }

    handlePrevious() {
        if (this.isDestroyed) return;
        if (this.activeTab && this.currentSearchTerm && !this.activeTab.webContents.isDestroyed()) {
            this.activeTab.webContents.findInPage(this.currentSearchTerm, { findNext: true, forward: false });
        }
    }

    handleClear() {
        if (this.isDestroyed) return;
        if (this.activeTab && !this.activeTab.webContents.isDestroyed()) {
            this.activeTab.webContents.stopFindInPage('clearSelection');
        }
    }

    handleFindResult(result) {
        if (this.isDestroyed) return;
        if (this.findWindow && !this.findWindow.isDestroyed()) {
            this.findWindow.webContents.send('find-matches-updated', result.activeMatchOrdinal, result.matches);
        }
    }
}

export default FindDialogManager;