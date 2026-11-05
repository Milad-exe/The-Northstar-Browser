/**
 * Northstar — At-rest encryption
 *
 * AES-256-GCM over a master key generated once with a CSPRNG. The GCM auth tag
 * gives tamper-detection equivalent to an HMAC. Blob shape:
 *   { v: 1, iv: <base64-12B>, tag: <base64-16B>, data: <base64-ciphertext> }
 *
 * KEY PROTECTION. The key used to live in `userData/northstar/.key` as raw
 * bytes at mode 0600, which meant saved passwords were protected by file
 * permissions alone: any process running as the user, any backup, any copied
 * disk image handed over the plaintext. The key is now *wrapped* with Electron's
 * safeStorage — the OS keychain (Keychain on macOS, libsecret on Linux, DPAPI on
 * Windows) — and only the wrapped form is written (`.key.enc`). An existing raw
 * key is migrated on first run and the raw file deleted.
 *
 * safeStorage is not always available (a Linux box with no keyring, an
 * unsigned build the user denied keychain access to). Rather than refuse to
 * start or silently downgrade every user, we fall back to the raw key file and
 * record that fact in `keyProtection()`, which Settings → Privacy surfaces so
 * the weaker state is visible rather than assumed.
 *
 * A key file that exists but can't be used is NEVER silently replaced: doing so
 * makes every saved password and the whole history file permanently unreadable.
 * It is moved aside as `.key.broken-<timestamp>` first, so the data is at least
 * recoverable if the cause was transient (a locked keychain, a half-written
 * file).
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./log');
const ALGO = 'aes-256-gcm';
const KEY_BYTES = 32; // 256-bit key
const IV_BYTES = 12; // 96-bit IV — optimal for GCM
const TAG_BYTES = 16; // 128-bit auth tag
let cachedKey = null;
let cachedKeyDir = null;
let protection = 'unknown'; // 'os-keychain' | 'file' — see keyProtection()

// ── Key paths ───────────────────────────────────────────────────────────────
function keyDir() {
    if (cachedKeyDir)
        return cachedKeyDir;
    try {
        const { app } = require('electron');
        cachedKeyDir = path.join(app.getPath('userData'), 'northstar');
    }
    catch {
        cachedKeyDir = process.cwd();
    }
    return cachedKeyDir;
}
const rawKeyPath = () => path.join(keyDir(), '.key');
const wrappedKeyPath = () => path.join(keyDir(), '.key.enc');

function safeStorage() {
    try {
        const { safeStorage } = require('electron');
        return safeStorage?.isEncryptionAvailable() ? safeStorage : null;
    }
    catch {
        return null;
    }
}

/** Move a key we cannot use out of the way instead of destroying the data. */
function quarantine(file) {
    try {
        if (fs.existsSync(file))
            fs.renameSync(file, `${file}.broken-${Date.now()}`);
    }
    catch (e) {
        log.error('encryption', 'could not set aside an unusable key file', e);
    }
}

function writeKey(key) {
    const ss = safeStorage();
    if (ss) {
        try {
            fs.writeFileSync(wrappedKeyPath(), ss.encryptString(key.toString('base64')), { mode: 0o600 });
            protection = 'os-keychain';
            return;
        }
        catch (e) {
            log.warn('encryption', 'OS secure store write failed; falling back to a file-protected key', e);
        }
    }
    fs.writeFileSync(rawKeyPath(), key, { mode: 0o600 });
    protection = 'file';
}

// ── Key loading / generation ─────────────────────────────────────────────────
function getKey() {
    if (cachedKey)
        return cachedKey;
    const dir = keyDir();
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    const ss = safeStorage();
    // 1. Wrapped key — the normal path once migrated.
    if (fs.existsSync(wrappedKeyPath())) {
        if (!ss) {
            // The OS secure store is unavailable *right now* (locked session,
            // denied access). Unwrapping is impossible; regenerating would orphan the
            // user's data, so fail loudly instead.
            throw new Error('encryption key is wrapped by the OS secure store, which is currently unavailable');
        }
        try {
            const b64 = ss.decryptString(fs.readFileSync(wrappedKeyPath()));
            const key = Buffer.from(b64, 'base64');
            if (key.length === KEY_BYTES) {
                cachedKey = key;
                protection = 'os-keychain';
                return cachedKey;
            }
            throw new Error('wrapped key had the wrong length');
        }
        catch (e) {
            log.error('encryption', 'wrapped key unreadable — set aside, starting a new one', e);
            quarantine(wrappedKeyPath());
        }
    }
    // 2. Raw key from before keychain wrapping — adopt it, then re-wrap.
    if (fs.existsSync(rawKeyPath())) {
        const stored = fs.readFileSync(rawKeyPath());
        if (stored.length === KEY_BYTES) {
            cachedKey = stored;
            if (ss) {
                try {
                    fs.writeFileSync(wrappedKeyPath(), ss.encryptString(stored.toString('base64')), { mode: 0o600 });
                    fs.unlinkSync(rawKeyPath()); // the plaintext copy is the whole problem
                    protection = 'os-keychain';
                    log.info('encryption', 'migrated the at-rest key into the OS secure store');
                }
                catch (e) {
                    protection = 'file';
                    log.warn('encryption', 'OS secure store migration failed; key stays file-protected', e);
                }
            }
            else {
                protection = 'file';
            }
            return cachedKey;
        }
        log.error('encryption', 'key file is the wrong size — set aside rather than overwritten');
        quarantine(rawKeyPath());
    }
    // 3. First run (or everything above was unusable) — mint a fresh key.
    cachedKey = crypto.randomBytes(KEY_BYTES);
    writeKey(cachedKey);
    return cachedKey;
}

/**
 * Wrap a still-raw key with the OS secure store. On Windows that store (DPAPI)
 * only reports available once the app is ready, but the key can be read before
 * that — and getKey() caches the 'file' state for the rest of the run. Left
 * there, the raw key sat beside the data it protects for good. Call once the
 * app is ready; a no-op when the key is already wrapped or the store is absent.
 */
function upgradeProtection() {
    if (protection === 'os-keychain')
        return protection;
    try {
        const key = getKey();
        const ss = safeStorage();
        if (!ss || !fs.existsSync(rawKeyPath()))
            return protection;
        fs.writeFileSync(wrappedKeyPath(), ss.encryptString(key.toString('base64')), { mode: 0o600 });
        // Prove the wrapped copy opens before the raw one goes.
        const back = Buffer.from(ss.decryptString(fs.readFileSync(wrappedKeyPath())), 'base64');
        if (!back.equals(key))
            throw new Error('wrapped key did not round-trip');
        fs.unlinkSync(rawKeyPath());
        protection = 'os-keychain';
        log.info('encryption', 'migrated the at-rest key into the OS secure store');
    }
    catch (e) {
        log.warn('encryption', 'OS secure store migration failed; key stays file-protected', e);
        try { if (fs.existsSync(rawKeyPath())) fs.rmSync(wrappedKeyPath(), { force: true }); }
        catch (e2) { log.debug('encryption', 'clean up half-written wrapped key', e2); }
    }
    return protection;
}
/**
 * How the master key is protected: 'os-keychain' (wrapped by the OS), or 'file'
 * (permissions only — weaker). Settings surfaces this rather than implying the
 * strong case.
 */
function keyProtection() {
    try {
        getKey();
    }
    catch {
        return 'unavailable';
    }
    return protection;
}
// ── Public API ────────────────────────────────────────────────────────────────
/**
 * Encrypt a UTF-8 string.
 * Returns a JSON string safe to store in a file.
 */
function encrypt(plaintext) {
    const key = getKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv, { authTagLength: TAG_BYTES });
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        v: 1,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: encrypted.toString('base64')
    });
}
/**
 * Decrypt a value produced by encrypt().
 * Throws if the data has been tampered with (GCM auth tag mismatch).
 */
function decrypt(ciphertext) {
    const key = getKey();
    const { iv, tag, data } = JSON.parse(ciphertext);
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(iv, 'base64'), { authTagLength: TAG_BYTES });
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
        decipher.update(Buffer.from(data, 'base64')),
        decipher.final()
    ]).toString('utf8');
}
/**
 * Returns true if the string looks like an encrypted blob written by encrypt().
 * Used for seamless migration from plaintext files.
 */
function isEncrypted(str) {
    try {
        const obj = JSON.parse(str);
        return !!(obj && obj.v === 1 && obj.iv && obj.tag && obj.data);
    }
    catch {
        return false;
    }
}

module.exports = { encrypt, decrypt, isEncrypted, keyProtection, upgradeProtection };