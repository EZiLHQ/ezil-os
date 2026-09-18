'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { CODE_SERVER } = require('../src/editor.cjs');
function verifyArchive(file) {
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== CODE_SERVER.sha256) throw Error('code-server archive SHA256 mismatch');
}
function binaryKind(file) {
  const bytes = Buffer.alloc(4), fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, bytes, 0, 4, 0); } finally { fs.closeSync(fd); }
  const magic = bytes.toString('hex');
  if (['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface', 'cafebabe', 'bebafeca', 'cafebabf'].includes(magic)) return 'Mach-O';
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
        } else if (kind === 'foreign') throw Error('Foreign runtime binary');
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
  const archive = path.join(build, CODE_SERVER.archive);
  run('/usr/bin/curl', ['--fail', '--location', '--proto', '=https', '--tlsv1.2', '--output', archive, `https://github.com/coder/code-server/releases/download/v${CODE_SERVER.version}/${CODE_SERVER.archive}`]);
  verifyArchive(archive);
  const entries = run('/usr/bin/tar', ['-tzf', archive], { stdio: 'pipe', encoding: 'utf8' }).trim().split('\n');
  const prefix = `code-server-${CODE_SERVER.version}-macos-arm64/`;
  if (entries.some(entry => !entry.startsWith(prefix) || entry.split('/').includes('..'))) throw Error('Unsafe runtime archive');
  const destination = path.join(resources, 'code-server'); fs.mkdirSync(destination, { mode: 0o700 });
  run('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
  const inventory = inspectTree(destination, run);
  if (!run(path.join(destination, 'bin/code-server'), ['--version'], { stdio: 'pipe', encoding: 'utf8' }).startsWith(CODE_SERVER.version)) throw Error('code-server version mismatch');
  return inventory;
}
module.exports = { verifyArchive, inspectTree, stageCodeServer, binaryKind };
