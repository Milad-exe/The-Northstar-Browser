/**
 * Full distributable builder — `npm run dist [mac|win|linux|all ...]`.
 *
 * Builds each platform's installer SEPARATELY (one electron-builder run per
 * target) so every artifact gets its own clean pack + VMP signature. Widevine
 * VMP signing (castlabs EVS) runs automatically inside electron-builder via the
 * hooks in scripts/vmp-sign.js — that's the signing DRM playback (Crunchyroll,
 * Netflix…) requires, and it's cloud-based so it works from any host OS.
 *
 * Usage:
 *   npm run dist              # every platform buildable on this host
 *   npm run dist mac          # just macOS  → dist/*.dmg
 *   npm run dist win linux    # Windows (.exe) + Linux (.AppImage)
 *
 * Host limits (electron-builder): a macOS .dmg can only be produced ON macOS;
 * Windows and Linux targets build from macOS or Linux. Targets that can't be
 * built on this host are skipped with a message.
 *
 * Signing is mandatory by default — if the castlabs EVS toolchain isn't set up
 * the build aborts before packing so you never ship an unsigned binary. Set
 * SKIP_VMP=1 to build unsigned (local testing only; DRM won't work).
 *
 * OS code signing (not required for DRM, off by default) is honored when the
 * standard electron-builder env vars are present: CSC_LINK / CSC_KEY_PASSWORD
 * (Windows Authenticode, macOS codesign) and APPLE_ID / APPLE_APP_SPECIFIC_
 * PASSWORD / APPLE_TEAM_ID (macOS notarization).
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const builder = require('electron-builder');
const { Platform, Arch } = builder;

const HOST = process.platform; // 'darwin' | 'win32' | 'linux'

// Default archs target what castlabs publishes and what users run: macOS is
// Apple Silicon only (arm64 — we don't ship Intel), Windows/Linux ship x64.
// Override all platforms with a bare `x64` / `arm64` / `universal` token.
//
// vmp: whether the platform gets a Widevine VMP signature. Linux can't —
// castlabs EVS only signs macOS .app / Windows .exe (see scripts/vmp-sign.js).
const PLATFORMS = {
    mac:   { label: 'macOS',   target: Platform.MAC,     ext: '.dmg',      buildableOn: ['darwin'],                   arch: ['arm64'], vmp: true },
    win:   { label: 'Windows', target: Platform.WINDOWS, ext: '.exe',      buildableOn: ['darwin', 'linux', 'win32'], arch: ['x64'],   vmp: true },
    linux: { label: 'Linux',   target: Platform.LINUX,   ext: '.AppImage', buildableOn: ['darwin', 'linux', 'win32'], arch: ['x64'],   vmp: false },
};

function resolvePython() {
    for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
        try { execFileSync(cmd[0], [...cmd.slice(1), '--version'], { stdio: 'ignore' }); return cmd; }
        catch { /* next */ }
    }
    return null;
}

// Preflight: without the castlabs EVS module every build silently produces an
// UNSIGNED binary (the hook warns but continues). Catch that here so a "release"
// build can't quietly ship broken DRM.
function assertSigningReady() {
    if (process.env.SKIP_VMP === '1') {
        console.warn('\n⚠  SKIP_VMP=1 — building WITHOUT VMP signing. DRM video will not work.\n');
        return;
    }
    const py = resolvePython();
    const hint =
        '\n   Set up once (free):  pip install castlabs-evs\n' +
        '                        python -m castlabs_evs.account signup   (or `reauth` on CI)\n' +
        '   Or build unsigned:   SKIP_VMP=1 npm run dist ...\n';
    if (!py) { console.error('✗ Python 3 not found — required for VMP signing.' + hint); process.exit(1); }
    try {
        execFileSync(py[0], [...py.slice(1), '-c', 'import castlabs_evs'], { stdio: 'ignore' });
    } catch {
        console.error('✗ castlabs-evs is not installed — VMP signing would fail.' + hint);
        process.exit(1);
    }
}

// Compile TS + CSS + copy assets into app/ (electron-builder only packages app/).
function buildWebApp() {
    console.log('\n▸ Compiling app (tsc + tailwind + assets)…');
    const r = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: HOST === 'win32' });
    if (r.status !== 0) { console.error('✗ app build failed'); process.exit(1); }
}

// Watch this build's stdout/stderr for the vmp-sign hook's markers so the final
// summary can report signing truthfully, without touching vmp-sign.js.
async function buildWatchingSignature(platform, archNames) {
    const archs = archNames.map(a => Arch[a] ?? Arch.x64);
    const target = platform.target.createTarget(null, ...archs);
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const seen = { signed: false, warned: false };
    const sniff = (s) => {
        if (s.includes('production VMP signature applied')) seen.signed = true;
        if (s.includes('[vmp-sign] WARNING')) seen.warned = true;
    };
    process.stdout.write = (c, ...a) => { sniff(c.toString()); return origOut(c, ...a); };
    process.stderr.write = (c, ...a) => { sniff(c.toString()); return origErr(c, ...a); };
    try {
        const artifacts = await builder.build({ targets: target });
        return { artifacts, ...seen };
    } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
    }
}

async function main() {
    const args = process.argv.slice(2).map(a => a.toLowerCase());
    const archOverride = ['x64', 'arm64', 'universal'].find(a => args.includes(a)) || null;
    let wanted = args.filter(a => PLATFORMS[a]);
    if (args.includes('all') || wanted.length === 0) wanted = Object.keys(PLATFORMS);
    wanted = [...new Set(wanted)];

    const skipped = wanted.filter(p => !PLATFORMS[p].buildableOn.includes(HOST));
    const build = wanted.filter(p => PLATFORMS[p].buildableOn.includes(HOST));

    console.log(`\nNorthstar — building [${build.map(p => PLATFORMS[p].label).join(', ') || 'nothing'}] on ${HOST}`);
    skipped.forEach(p => console.log(`  · skipping ${PLATFORMS[p].label} — can only be built on ${PLATFORMS[p].buildableOn.join('/')}`));

    if (!build.length) { console.error('\n✗ No requested platform is buildable on this host.'); process.exit(1); }

    assertSigningReady();
    buildWebApp();

    const results = [];
    for (const key of build) {
        const p = PLATFORMS[key];
        const archNames = archOverride ? [archOverride] : p.arch;
        console.log(`\n━━ ${p.label} (${archNames.join('+')}) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
        try {
            const { artifacts, signed, warned } = await buildWatchingSignature(p, archNames);
            const installers = (artifacts || []).filter(f => f.endsWith(p.ext));
            results.push({ label: p.label, ok: true, installers, signed, warned, vmp: p.vmp });
        } catch (err) {
            console.error(`\n✗ ${p.label} build failed:`, err && err.message ? err.message : err);
            results.push({ label: p.label, ok: false, installers: [], signed: false, warned: false, vmp: p.vmp });
        }
    }

    console.log('\n══ Summary ═══════════════════════════════════════════');
    for (const r of results) {
        const status = !r.ok ? 'FAILED'
            : !r.vmp ? 'built (Widevine VMP N/A on this platform)'
            : process.env.SKIP_VMP === '1' ? 'built (UNSIGNED — SKIP_VMP)'
            : r.signed && !r.warned ? 'built + VMP-signed'
            : r.warned ? 'built but VMP signing FAILED (DRM broken)'
            : 'built (VMP status unknown — check log)';
        console.log(`  ${r.ok ? '✓' : '✗'} ${r.label.padEnd(8)} ${status}`);
        r.installers.forEach(f => console.log(`      → ${path.relative(process.cwd(), f)}`));
    }
    console.log('');

    const bad = results.some(r => !r.ok || (r.vmp && process.env.SKIP_VMP !== '1' && r.warned));
    process.exit(bad ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
