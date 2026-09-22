'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CODE_SERVER } = require('../src/editor.cjs');
// These exact platform-only helpers are shipped in the pinned upstream archive.
// Keep notices and portable PowerShell assemblies; reject every unknown binary.
const PLATFORM_ONLY = [
  'lib/vscode/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.win32-arm64-msvc-4ZJZ3U55.node',
  'lib/vscode/extensions/ms-vscode.js-debug/src/win32-app-container-tokens.win32-x64-msvc-VCQE7GJP.node',
  ...['lxc-exec', 'mxc-diagnostic-console.exe', 'plm.exe', 'winhttp-proxy-shim.exe', 'wslcsdk.dll', 'wxc-exec.exe', 'wxc-host-prep.exe', 'wxc-test-proxy.exe', 'wxc-windows-sandbox-daemon.exe', 'wxc-windows-sandbox-guest.exe', 'wxc-wslc-daemon.exe'].map(name => 'lib/vscode/node_modules/@microsoft/mxc-sdk/bin/arm64/' + name),
  'lib/vscode/node_modules/@vscode/sandbox-runtime/vendor/seccomp/x64/apply-seccomp'
];
function portableAssembly(file) {
  const b = fs.readFileSync(file);
  if (b.length < 64 || b.readUInt16LE(0) !== 0x5a4d) return false;
  const pe = b.readUInt32LE(60);
  if (pe + 248 > b.length || b.readUInt32LE(pe) !== 0x4550 || b.readUInt16LE(pe + 4) !== 0x14c || b.readUInt16LE(pe + 24) !== 0x10b) return false;
  const clr = b.readUInt32LE(pe + 24 + 96 + 14 * 8), count = b.readUInt16LE(pe + 6);
  const sections = pe + 24 + b.readUInt16LE(pe + 20);
  for (let i = 0; i < count; i++) {
    const s = sections + i * 40;
    if (s + 40 > b.length) return false;
    const rva = b.readUInt32LE(s + 12), size = b.readUInt32LE(s + 16);
    if (clr >= rva && clr + 20 <= rva + size) {
      const offset = clr - rva + b.readUInt32LE(s + 20);
      if (offset + 20 > b.length) return false;
      const flags = b.readUInt32LE(offset + 16);
      return !!(flags & 1) && !(flags & 0x12); // IL-only; no 32-bit requirement or native entrypoint.
    }
  }
  return false;
}
function prunePlatformHelpers(root) {
  return PLATFORM_ONLY.flatMap(relative => {
    const file = path.join(root, relative), stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep) || binaryKind(file) !== 'foreign') throw Error('Unexpected platform helper');
    const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    fs.unlinkSync(file);
    return [{ path: relative, sha256, reason: 'Windows/Linux-only helper; macOS arm64 distribution' }];
  });
}
function thinUniversalHelpers(root, run) {
  const relative = 'lib/vscode/node_modules/kerberos/build/Release/kerberos.node', file = path.join(root, relative);
  const arch = run('/usr/bin/lipo', ['-archs', file], { stdio: 'pipe', encoding: 'utf8' }).trim();
  if (arch === 'arm64') return [];
  if (arch !== 'x86_64 arm64' || !fs.lstatSync(file).isFile() || !fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw Error('Unexpected Kerberos helper');
  const sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  run('/usr/bin/lipo', [file, '-thin', 'arm64', '-output', file + '.arm64']);
  fs.renameSync(file + '.arm64', file);
  return [{ path: relative, originalSHA256: sha256, change: 'Retained arm64 slice of upstream universal binary' }];
}
function verifyArchive(file) {
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== CODE_SERVER.sha256) throw Error('code-server archive SHA256 mismatch');
}
function binaryKind(file) {
  const bytes = Buffer.alloc(16), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, bytes, 0, 16, 0); } finally { fs.closeSync(fd); }
  const magic = bytes.subarray(0, 4).toString('hex');
  if (['cffaedfe', 'cefaedfe'].includes(magic) && bytes.readUInt32LE(12) === 1) return 'Mach-O-object';
  if (['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf'].includes(magic)) return 'Mach-O';
  if (magic.startsWith('4d5a') && portableAssembly(file)) return 'managed';
  if (magic === '7f454c46' || magic.startsWith('4d5a')) return 'foreign';
  return 'data';
}
function inspectTree(root, run) {
  const files = [], licenses = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (!target.startsWith(root + path.sep)) throw Error('Runtime link escapes package');
        continue;
      }
      if (stat.mode & 0o022) fs.chmodSync(file, stat.mode & ~0o022);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        const kind = binaryKind(file);
        if (/Mach-O/.test(kind)) {
          const arch = run('/usr/bin/lipo', ['-archs', file], { stdio: 'pipe', encoding: 'utf8' }).trim();
          if (arch !== 'arm64') throw Error('Runtime architecture mismatch');
          files.push(file);
        } else if (kind === 'foreign') throw Error('Foreign runtime binary: ' + path.relative(root, file));
        if (/license|notice|thirdpartynotices/i.test(entry.name)) licenses.push(path.relative(root, file));
      } else throw Error('Unsupported runtime entry');
    }
  }
  visit(root);
  if (!files.length || !licenses.length) throw Error('Runtime binaries or notices missing');
  for (const file of ['bin/code-server', 'lib/node']) if (!(fs.statSync(path.join(root, file)).mode & 0o111)) throw Error('Runtime executable permission missing');
  return { version: CODE_SERVER.version, archiveSHA256: CODE_SERVER.sha256, architecture: 'arm64', nativeFiles: files.map(f => path.relative(root, f)), licenses };
}
function stageCodeServer(build, resources, run) {
  const archive = path.join(process.env.EZIL_CODE_SERVER_CACHE || build, CODE_SERVER.archive);
  if (!fs.existsSync(archive)) run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--output', archive, `https://github.com/coder/code-server/releases/download/v${CODE_SERVER.version}/${CODE_SERVER.archive}`]);
  verifyArchive(archive);
  const entries = run('/usr/bin/tar', ['-tzf', archive], { stdio: 'pipe', encoding: 'utf8' }).trim().split('\n');
  const prefix = `code-server-${CODE_SERVER.version}-macos-arm64/`;
  if (entries.some(entry => !entry.startsWith(prefix) || entry.split('/').includes('..'))) throw Error('Unsafe runtime archive');
  const destination = path.join(resources, 'code-server'); fs.mkdirSync(destination, { mode: 0o700 });
  run('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
  const prunedFiles = prunePlatformHelpers(destination);
  const thinnedFiles = thinUniversalHelpers(destination, run);
  const inventory = inspectTree(destination, run);
  inventory.prunedFiles = prunedFiles;
  inventory.thinnedFiles = thinnedFiles;
  if (!run(path.join(destination, 'bin/code-server'), ['--config', path.join(build, 'version-probe.yaml'), '--version'], { stdio: 'pipe', encoding: 'utf8' }).trim().split('\n').some(line => line.startsWith(CODE_SERVER.version + ' '))) throw Error('code-server version mismatch');
  return inventory;
}
module.exports = { verifyArchive, inspectTree, stageCodeServer, binaryKind, portableAssembly, prunePlatformHelpers, thinUniversalHelpers };
