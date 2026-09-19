'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyTree, privateDir, atomic } = require('../src/files.cjs');
const { bundleHelper } = require('./bundle-helper.cjs');
const { stageCodeServer, binaryKind } = require('./code-server.cjs');
const { validateInputs, stageInputs } = require('./inputs.cjs');
const { verifyRuntimeBundle } = require('./verify-bundle.cjs');
const root = path.resolve(__dirname, '..'), repo = path.dirname(root);
const pkg = require('../package.json');
function run(bin, args, options = {}) { return execFileSync(bin, args, { stdio: 'inherit', ...options }); }
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Package on an Apple Silicon Mac');
if (process.version !== `v${pkg.ezilTools.node}` || run('npm', ['--version'], { stdio: 'pipe', encoding: 'utf8' }).trim() !== pkg.ezilTools.npm) throw Error('Install the exact Node/npm tool versions in package.json');
if (process.argv.length > 2) throw Error('Only internal ad-hoc packaging is implemented. Public release requires a separately reviewed Developer ID/notarization path.');
const version = process.env.EZIL_BUILD_VERSION || pkg.version;
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw Error('Invalid build version');
const nativeSource = path.resolve(process.env.EZIL_PACKAGE_HELPER || path.join(repo, 'native'));
const shellSource = path.resolve(process.env.EZIL_PACKAGE_SHELL || path.join(repo, 'app/public/os'));
const inputs = { helper: nativeSource, shell: shellSource, extension: path.join(repo, 'extensions/ezil-vscode') };
validateInputs(inputs);
if (!fs.existsSync(path.join(root, 'package-lock.json'))) throw Error('Commit the npm package-lock before packaging');
const electronPackage = require('electron/package.json');
if (electronPackage.version !== pkg.devDependencies.electron) throw Error('Electron version mismatch');
const electronRoot = path.dirname(require.resolve('electron/package.json'));
const template = path.join(electronRoot, 'dist/Electron.app');
if (!fs.existsSync(template)) throw Error('Install the pinned Darwin arm64 Electron binary first');
const build = fs.mkdtempSync(path.join(privateDir(path.resolve(process.env.EZIL_STAGE_ROOT || path.join(root, '.stage'))), 'build-'));
const out = privateDir(path.resolve(process.env.EZIL_DIST || path.join(root, 'dist')));
const bundle = path.join(build, 'EZiL OS.app');
run('/usr/bin/ditto', [template, bundle]);
// Electron identifies its default executable as development mode, even inside
// a renamed .app bundle. Production resource selection requires a branded
// executable as well as the matching signed Info.plist entry.
fs.renameSync(path.join(bundle, 'Contents/MacOS/Electron'), path.join(bundle, 'Contents/MacOS/EZiL OS'));
const resources = path.join(bundle, 'Contents/Resources');
fs.rmSync(path.join(resources, 'default_app.asar'), { force: true });
const host = privateDir(path.join(resources, 'app'));
for (const dir of ['src', 'ui']) copyTree(path.join(root, dir), path.join(host, dir));
atomic(path.join(host, 'package.json'), JSON.stringify({ name: pkg.name, version, main: pkg.main }));
const inputInventory = stageInputs(inputs, resources);
// Bun's exact platform package is obtained through npm's integrity-checked
// registry download. Preserve its resolved lock/integrity in the inventory.
const bunStage = privateDir(path.join(build, 'bun-package'));
atomic(path.join(bunStage, 'package.json'), JSON.stringify({ private: true, dependencies: { '@oven/bun-darwin-aarch64': pkg.ezilTools.bun } }));
run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: bunStage });
const bunPackage = path.join(bunStage, 'node_modules/@oven/bun-darwin-aarch64');
const bun = path.join(privateDir(path.join(resources, 'bun')), 'bun');
fs.copyFileSync(path.join(bunPackage, 'bin/bun'), bun); fs.chmodSync(bun, 0o755);
if (run(bun, ['--version'], { encoding: 'utf8', stdio: 'pipe' }).trim() !== pkg.ezilTools.bun) throw Error('Bundled Bun version mismatch');
inputInventory.helper = bundleHelper(bun, nativeSource, resources);
const codeServerInventory = stageCodeServer(build, resources, run);
const licenses = privateDir(path.join(resources, 'licenses'));
for (const file of ['LICENSE', 'NOTICE', 'ATTRIBUTIONS.md']) fs.copyFileSync(path.join(repo, file), path.join(licenses, file));
fs.copyFileSync(path.join(repo, 'shell/PUTER-PROVENANCE.md'), path.join(licenses, 'PUTER-PROVENANCE.md'));
for (const file of ['LICENSE', 'LICENSES.chromium.html']) {
  const source = path.join(electronRoot, 'dist', file); if (!fs.existsSync(source)) throw Error('Electron/Chromium licenses missing');
  fs.copyFileSync(source, path.join(licenses, file === 'LICENSE' ? 'ELECTRON-LICENSE' : file));
}
// Fail instead of silently distributing Bun without its notices.
const bunNotice = ['README.md', 'LICENSE', 'LICENSE.md'].find(file => fs.existsSync(path.join(bunPackage, file)));
if (!bunNotice) throw Error('Bun package notices missing');
fs.copyFileSync(path.join(bunPackage, bunNotice), path.join(licenses, 'BUN-PACKAGE-NOTICE'));
atomic(path.join(licenses, 'BUN-LICENSE-SOURCE.txt'), `Bun ${pkg.ezilTools.bun}: https://github.com/oven-sh/bun/tree/bun-v${pkg.ezilTools.bun}\nMIT license; JavaScriptCore and bundled third-party notices must accompany this binary.\n`);
// Download versioned upstream license, including third-party notices, over TLS.
run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--output', path.join(licenses, 'BUN-LICENSE.md'), `https://raw.githubusercontent.com/oven-sh/bun/bun-v${pkg.ezilTools.bun}/LICENSE.md`]);
fs.copyFileSync(path.join(bunStage, 'package-lock.json'), path.join(resources, 'BUN-PACKAGE-LOCK.json'));
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(resources, 'HOST-BUILD-LOCK.json'));
const plist = path.join(bundle, 'Contents/Info.plist');
for (const [key, value] of Object.entries({ CFBundleIdentifier: 'com.ezil.os.native', CFBundleExecutable: 'EZiL OS', CFBundleName: 'EZiL OS', CFBundleDisplayName: 'EZiL OS', CFBundleShortVersionString: version, CFBundleVersion: version.split('-')[0] })) run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
const inventory = { distribution: 'internal-ad-hoc', version, gitSHA: process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD'], { cwd: repo, stdio: 'pipe', encoding: 'utf8' }).trim(), electron: pkg.devDependencies.electron, bun: pkg.ezilTools.bun, node: process.version, files: {} };
inventory.inputs = inputInventory;
inventory.architecture = 'arm64';
inventory.codeServer = codeServerInventory;
// Never produce another shell-only installer. Verify the application owns all
// runtime dependencies before signing, without relying on the build SSD.
inventory.portabilityBeforeSigning = verifyRuntimeBundle(resources, inventory);
const runtimeComponents = new Map();
function componentPackages(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) componentPackages(file);
    else if (entry.isFile() && entry.name === 'package.json') {
      let metadata; try { metadata = JSON.parse(fs.readFileSync(file)); } catch { throw Error('Invalid runtime package manifest'); }
      if (typeof metadata.name === 'string' && typeof metadata.version === 'string') runtimeComponents.set(`${metadata.name}@${metadata.version}`, { type: 'library', name: metadata.name, version: metadata.version, ...(typeof metadata.license === 'string' ? { licenses: [{ license: { name: metadata.license } }] } : {}) });
    }
  }
}
componentPackages(path.join(resources, 'code-server'));
atomic(path.join(resources, 'SBOM.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, components: [...runtimeComponents.values(), { type: 'application', name: 'electron', version: pkg.devDependencies.electron }, { type: 'application', name: 'bun', version: pkg.ezilTools.bun }, { type: 'application', name: 'code-server', version: codeServerInventory.version, hashes: [{ alg: 'SHA-256', content: codeServerInventory.archiveSHA256 }] }], properties: [{ name: 'ezil:dependency-evidence', value: 'INVENTORY.json; BUN-PACKAGE-LOCK.json; HOST-BUILD-LOCK.json; native/closure.json; code-server/package.json; code-server/lib/vscode/package.json' }] }, null, 2));
function inventoryFiles(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) inventoryFiles(file); else if (item.isFile()) inventory.files[path.relative(resources, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } }
// Sign executable components bottom-up. No virtualization entitlements/runtime.
function signTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { signTree(file); if (/\.(app|framework)$/.test(file)) run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', file]); }
    else if (entry.isFile() && binaryKind(file) === 'Mach-O') {
      if (run('/usr/bin/lipo', ['-archs', file], { stdio: 'pipe', encoding: 'utf8' }).trim() !== 'arm64') throw Error('Nested binary architecture mismatch');
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', file]);
      run('/usr/bin/codesign', ['--verify', '--strict', file]);
    }
  }
}
signTree(bundle);
inventoryFiles(resources); atomic(path.join(resources, 'INVENTORY.json'), JSON.stringify(inventory, null, 2));
run('/usr/bin/codesign', ['--force', '--sign', '-', '--preserve-metadata=entitlements', bundle]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
const dmgStage = privateDir(path.join(build, 'image'));
run('/usr/bin/ditto', [bundle, path.join(dmgStage, 'EZiL OS.app')]); fs.symlinkSync('/Applications', path.join(dmgStage, 'Applications'));
const dmg = path.join(out, `EZiL-OS-${version}-AppleSilicon-internal.dmg`);
run('/usr/bin/hdiutil', ['create', '-volname', 'EZiL OS Internal', '-srcfolder', dmgStage, '-ov', '-format', 'UDZO', dmg]);
run('/usr/bin/hdiutil', ['verify', dmg]);
const hash = createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
atomic(dmg + '.sha256', `${hash}  ${path.basename(dmg)}\n`);
fs.copyFileSync(path.join(resources, 'INVENTORY.json'), path.join(out, 'INVENTORY.json'));
fs.copyFileSync(path.join(resources, 'SBOM.json'), path.join(out, 'SBOM.json'));
console.log(`Internal ad-hoc artifact: ${dmg}\nSHA256: ${hash}`);
