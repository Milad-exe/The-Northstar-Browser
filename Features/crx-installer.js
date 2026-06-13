'use strict';

const fs = require('fs');

/**
 * Parse a .crx file (v2 or v3) and return the embedded ZIP buffer.
 *
 * CRX3 layout:  magic(4) + version(4) + headerSize(4) + protobuf(headerSize) + ZIP
 * CRX2 layout:  magic(4) + version(4) + pubKeyLen(4) + sigLen(4) + pubKey + sig + ZIP
 */
function parseCrx(buffer) {
    const magic = buffer.slice(0, 4).toString('binary');
    if (magic !== 'Cr24') throw new Error('Not a valid CRX file (bad magic bytes)');

    const version = buffer.readUInt32LE(4);
    let zipStart;

    if (version === 3) {
        const headerSize = buffer.readUInt32LE(8);
        zipStart = 12 + headerSize;
    } else if (version === 2) {
        const pubKeyLen = buffer.readUInt32LE(8);
        const sigLen    = buffer.readUInt32LE(12);
        zipStart = 16 + pubKeyLen + sigLen;
    } else {
        throw new Error(`Unsupported CRX version: ${version}`);
    }

    if (zipStart >= buffer.length) throw new Error('CRX header is larger than the file');

    const zip = buffer.slice(zipStart);
    // Sanity-check: ZIP files start with PK\x03\x04
    if (zip[0] !== 0x50 || zip[1] !== 0x4B) throw new Error('CRX payload is not a valid ZIP');
    return zip;
}

/**
 * Unpack a CRX buffer into destDir.
 * Returns the parsed manifest object.
 */
async function installCrxToDir(crxBuffer, destDir) {
    const AdmZip = require('adm-zip');
    const zipBuffer = parseCrx(crxBuffer);
    const zip = new AdmZip(zipBuffer);

    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) throw new Error('Extension has no manifest.json');

    const manifest = JSON.parse(manifestEntry.getData().toString('utf-8'));

    fs.mkdirSync(destDir, { recursive: true });
    zip.extractAllTo(destDir, /* overwrite */ true);

    return manifest;
}

module.exports = { parseCrx, installCrxToDir };
