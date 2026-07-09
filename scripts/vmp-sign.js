/**
 * electron-builder afterPack hook — VMP-sign the packaged app via castlabs EVS.
 *
 * Widevine production license servers (DRMtoday — used by Crunchyroll, etc.)
 * only issue licenses to production-VMP-signed binaries. This signs the packaged
 * output so END USERS get a working-DRM build with zero setup on their side.
 *
 * Runs in afterPack, which is before macOS codesigning/notarization — required,
 * since VMP signing modifies the bundle and would invalidate Apple's signature.
 *
 * One-time developer setup (free): pip3 install castlabs-evs
 *   python3 -m castlabs_evs.account signup
 * CI: castlabs_evs.account reauth with EVS_ACCOUNT_NAME / EVS_PASSWD env vars.
 */

'use strict';

const { execSync } = require('child_process');

exports.default = async function vmpSign(context) {
  const dir = context.appOutDir;
  try {
    execSync(`python3 -m castlabs_evs.vmp --no-ask sign-pkg "${dir}"`, { stdio: 'inherit' });
    console.log(`[vmp-sign] production VMP signature applied: ${dir}`);
  } catch (err) {
    console.warn(
      '\n[vmp-sign] WARNING: VMP signing failed — DRM video (Crunchyroll, Netflix…) will NOT work in this build.\n' +
      '[vmp-sign] Set up castlabs EVS (free): pip3 install castlabs-evs && python3 -m castlabs_evs.account signup\n'
    );
  }
};
