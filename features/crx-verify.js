/**
 * .crx signature checking for "Add extension from file".
 *
 * An extension's id is derived from its public key, and an unpacked manifest
 * may carry that key itself (`manifest.key`). Without checking, a .crx could
 * claim any id it liked — a store extension's, or one already installed —
 * just by pasting that extension's key into its manifest. So:
 *
 *   - CRX3 / CRX2: the header's signature must verify against the archive,
 *     and the id is the signing key's. A manifest.key naming a different id
 *     is refused; a missing one is filled in so the installed id IS the
 *     signed id.
 *   - A bare .zip has no signature at all, so its manifest.key proves nothing
 *     and is dropped (the extension gets a path-derived id instead).
 *
 * Pure node (crypto only), so the unit tests can build and check archives.
 */
'use strict';
const crypto = require('crypto');

const CRX3_SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1');

/** Chrome's extension id: sha256 of the DER key, first 16 bytes, hex mapped to a–p. */
function idFromPublicKey(der) {
    const hex = crypto.createHash('sha256').update(der).digest('hex').slice(0, 32);
    return hex.replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
}

// ── Minimal protobuf reader (the CRX3 header is a protobuf) ──────────────────
function readVarint(buf, pos) {
    let value = 0;
    let shift = 0;
    for (;;) {
        if (pos >= buf.length)
            throw new Error('truncated varint');
        const b = buf[pos++];
        value += (b & 0x7f) * 2 ** shift;
        if (!(b & 0x80))
            return [value, pos];
        shift += 7;
        if (shift > 49)
            throw new Error('varint too long');
    }
}
/** Each field as { field, bytes } (length-delimited) — the only kind CRX3 uses. */
function readFields(buf) {
    const out = [];
    let pos = 0;
    while (pos < buf.length) {
        let tag;
        [tag, pos] = readVarint(buf, pos);
        const field = Math.floor(tag / 8);
        const wire = tag & 7;
        if (wire === 2) {
            let len;
            [len, pos] = readVarint(buf, pos);
            if (pos + len > buf.length)
                throw new Error('truncated field');
            out.push({ field, bytes: buf.subarray(pos, pos + len) });
            pos += len;
        }
        else if (wire === 0) {
            [, pos] = readVarint(buf, pos);
        }
        else if (wire === 5) {
            pos += 4;
        }
        else if (wire === 1) {
            pos += 8;
        }
        else {
            throw new Error('unsupported wire type ' + wire);
        }
    }
    return out;
}

function verifyWith(algorithm, data, der, signature) {
    try {
        return crypto.verify(algorithm, data, { key: der, format: 'der', type: 'spki' }, signature);
    }
    catch {
        return false;
    }
}

/**
 * Inspect a .crx/.zip buffer.
 * → { signed: false, zipOffset: 0 } for a bare zip,
 *   { signed: true, id, publicKey (base64), zipOffset } for a verified crx;
 * throws for a crx whose signature does not verify.
 */
function verifyCrx(buf) {
    if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'Cr24')
        return { signed: false, zipOffset: 0 };
    const version = buf.readUInt32LE(4);
    if (version === 2) {
        const keyLen = buf.readUInt32LE(8);
        const sigLen = buf.readUInt32LE(12);
        const zipOffset = 16 + keyLen + sigLen;
        if (zipOffset > buf.length)
            throw new Error('truncated CRX2 header');
        const der = buf.subarray(16, 16 + keyLen);
        const sig = buf.subarray(16 + keyLen, zipOffset);
        if (!verifyWith('sha1', buf.subarray(zipOffset), der, sig))
            throw new Error('the .crx signature does not match its contents');
        return { signed: true, id: idFromPublicKey(der), publicKey: der.toString('base64'), zipOffset };
    }
    if (version !== 3)
        throw new Error('unknown .crx version ' + version);
    const headerLen = buf.readUInt32LE(8);
    const zipOffset = 12 + headerLen;
    if (zipOffset > buf.length)
        throw new Error('truncated CRX3 header');
    const header = buf.subarray(12, zipOffset);
    const fields = readFields(header);
    const proofs = [];
    let signedHeaderData = null;
    for (const f of fields) {
        if (f.field === 2 || f.field === 3) {
            const proof = { algorithm: 'sha256', der: null, sig: null };
            for (const p of readFields(f.bytes)) {
                if (p.field === 1) proof.der = p.bytes;
                else if (p.field === 2) proof.sig = p.bytes;
            }
            if (proof.der && proof.sig)
                proofs.push(proof);
        }
        else if (f.field === 10000) {
            signedHeaderData = f.bytes;
        }
    }
    if (!signedHeaderData)
        throw new Error('the .crx has no signed header');
    let crxId = null;
    for (const f of readFields(signedHeaderData))
        if (f.field === 1)
            crxId = f.bytes.toString('hex').replace(/[0-9a-f]/g, c => String.fromCharCode(97 + parseInt(c, 16)));
    if (!crxId)
        throw new Error('the .crx header names no id');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(signedHeaderData.length, 0);
    const signed = Buffer.concat([CRX3_SIGNED_DATA_PREFIX, len, signedHeaderData, buf.subarray(zipOffset)]);
    // Every proof must hold (as in Chrome), and one of them must be by the key
    // the declared id comes from.
    let idKey = null;
    for (const p of proofs) {
        if (!verifyWith(p.algorithm, signed, p.der, p.sig))
            throw new Error('the .crx signature does not match its contents');
        if (idFromPublicKey(p.der) === crxId)
            idKey = p.der;
    }
    if (!idKey)
        throw new Error('the .crx is not signed by the key its id comes from');
    return { signed: true, id: crxId, publicKey: idKey.toString('base64'), zipOffset };
}

/**
 * Reconcile manifest.key with what the archive proved. Mutates and returns the
 * manifest; throws when the key would impersonate a different id.
 * → { manifest, changed, warning }
 */
function reconcileManifestKey(manifest, verdict) {
    const m = manifest && typeof manifest === 'object' ? manifest : {};
    if (!verdict?.signed) {
        if (m.key === undefined)
            return { manifest: m, changed: false, warning: null };
        delete m.key;
        return { manifest: m, changed: true, warning: 'unsigned archive: its manifest "key" was ignored' };
    }
    if (m.key !== undefined) {
        let keyId = null;
        try { keyId = idFromPublicKey(Buffer.from(String(m.key), 'base64')); }
        catch { keyId = null; }
        if (keyId !== verdict.id)
            throw new Error('the manifest "key" claims a different extension id than the .crx was signed with');
        return { manifest: m, changed: false, warning: null };
    }
    m.key = verdict.publicKey;
    return { manifest: m, changed: true, warning: null };
}

module.exports = { verifyCrx, reconcileManifestKey, idFromPublicKey };
