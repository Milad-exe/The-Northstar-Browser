/**
 * electron-builder afterPack hook — VMP-sign the packaged app via castlabs EVS.
 *
 * Widevine production license servers (DRMtoday — used by Crunchyroll, etc.)
 * only issue licenses to production-VMP-signed binaries. This signs the packaged
 * output so END USERS get a working-DRM build with zero setup on their side.
 *
 * Hook placement is platform-specific (castlabs: "or things will break"):
 *  - macOS: afterPack — BEFORE codesigning/notarization, since VMP signing
 *    modifies the bundle and would invalidate Apple's signature.
 *  - Windows: win.signtoolOptions.sign (custom sign hook) — AFTER electron-builder
 *    edits the exe (icon/version via rcedit), which happens after afterPack and
 *    would invalidate a VMP signature made there.
 *
 * One-time developer setup (free): pip install castlabs-evs
 *   <python> -m castlabs_evs.account signup
 * CI: castlabs_evs.account reauth with EVS_ACCOUNT_NAME / EVS_PASSWD env vars.
 *
 * Also runnable directly to sign the dev Electron (for `npm start` DRM testing):
 *   node scripts/vmp-sign.js node_modules/electron/dist
 */

'use strict';

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

// Resolve an available Python across platforms. The python.org Windows installer
// only provides `python` / `py` (no `python3.exe`), while macOS/Linux typically
// have `python3` — so probe for whatever exists instead of hardcoding one.
function resolvePython() {
  const candidates = [['python3'], ['python'], ['py', '-3']];
  for (const cmd of candidates) {
    try {
      execFileSync(cmd[0], [...cmd.slice(1), '--version'], { stdio: 'ignore' });
      return cmd;
    } catch { /* try next */ }
  }
  return null;
}

function signPkg(dir) {
  const py = resolvePython();
  if (!py) {
    console.warn(
      '\n[vmp-sign] WARNING: no Python found (tried python3, python, py -3).\n' +
      '[vmp-sign] Install Python 3 and `pip install castlabs-evs`, then rebuild.\n'
    );
    return false;
  }
  try {
    execFileSync(py[0], [...py.slice(1), '-m', 'castlabs_evs.vmp', '--no-ask', 'sign-pkg', dir], { stdio: 'inherit' });
    console.log(`[vmp-sign] production VMP signature applied: ${dir}`);
    return true;
  } catch {
    console.warn(
      '\n[vmp-sign] WARNING: VMP signing failed — DRM video (Crunchyroll, Netflix…) will NOT work in this build.\n' +
      `[vmp-sign] Set up castlabs EVS (free): pip install castlabs-evs && ${py.join(' ')} -m castlabs_evs.account signup\n`
    );
    return false;
  }
}

// Electron fuses — compiled-in switches that close the shipped binary to
// local tampering: no running it as a bare Node (ELECTRON_RUN_AS_NODE), no
// NODE_OPTIONS / --inspect injection, and app code only from the integrity-
// checked app.asar. Flipped HERE rather than via build.electronFuses because
// electron-builder applies that config after afterPack, i.e. after the macOS
// VMP signature below — rewriting the binary then would void it.
// (Cookie encryption is left off: switching it on is a one-way profile change.)
//
// NOT on Windows or macOS: castlabs EVS refuses to VMP-sign a binary whose fuse
// wire differs from the stock castlabs build ("ValidityError: Binary signature
// denied") — tested 2026-11-07 with all five flipped, only the three Node fuses,
// and only the two asar fuses; every variant was denied, the stock wire was
// signed. Without VMP, Widevine (Netflix, Crunchyroll) stops working, so on the
// VMP-signed platforms the fuses stay at their defaults. The packaged-build
// refusal of --remote-debugging-* (main.js) does not depend on fuses and stays.
const FUSES = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
};

// electron-builder afterPack hook: fuses on Linux only (see above), then VMP
// signing (macOS only — too early on Windows, see header comment; Windows goes
// through exports.sign below instead).
exports.default = async function vmpSign(context) {
  // generateFuseConfig turns these option names into the versioned
  // @electron/fuses config, exactly as build.electronFuses would.
  if (context.electronPlatformName === 'linux')
    await context.packager.addElectronFuses(context, await context.packager.generateFuseConfig(FUSES));
  // Windows is signed later via exports.sign (after rcedit). Linux is skipped
  // entirely: castlabs EVS only signs macOS .app / Windows .exe packages, and
  // Linux Widevine (L3) doesn't use VMP signing — trying to sign a Linux build
  // just errors with "No matching executable found".
  if (context.electronPlatformName === 'win32' || context.electronPlatformName === 'linux') return;
  signPkg(context.appOutDir);
};

// electron-builder Windows custom sign hook (win.signtoolOptions.sign).
// Called for every file electron-builder would codesign: the app exe (after
// resource editing — the moment we need), but also the NSIS uninstaller stub
// and the final installer, and once per hash algorithm. Only the unpacked
// Electron app dir carries a VMP signature, so filter to it and sign once.
exports.sign = async function (configuration) {
  if (configuration.isNest) return; // second (sha256) pass for the same file
  const dir = path.dirname(configuration.path);
  if (!fs.existsSync(path.join(dir, 'v8_context_snapshot.bin'))) return; // not the packaged Electron exe
  signPkg(dir);
};

// Direct invocation: `node scripts/vmp-sign.js <dir>` (defaults to the dev Electron).
if (require.main === module) {
  signPkg(process.argv[2] || 'node_modules/electron/dist');
}
