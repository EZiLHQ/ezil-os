'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { binaryKind, prunePlatformHelpers, inspectTree } = require('../scripts/code-server.cjs');
test('runtime pruning is exact, preserves portable assemblies, and rejects unknown foreign executables', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-binaries-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const put = (relative, data) => { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode: 0o700 }); return file; };
  const helper = 'lib/vscode/node_modules/@microsoft/mxc-sdk/bin/arm64/lxc-exec';
  put(helper, Buffer.from('7f454c46', 'hex'));
  const pruned = prunePlatformHelpers(root); assert.equal(pruned.length, 1); assert.equal(pruned[0].path, helper); assert.match(pruned[0].sha256, /^[a-f0-9]{64}$/);
  const b = Buffer.alloc(1024); b.writeUInt16LE(0x5a4d, 0); b.writeUInt32LE(64, 60); b.writeUInt32LE(0x4550, 64); b.writeUInt16LE(1, 70); b.writeUInt16LE(224, 84); b.writeUInt16LE(0x10b, 88); b.writeUInt32LE(8192, 296);
  b.writeUInt32LE(8192, 324); b.writeUInt32LE(512, 328); b.writeUInt32LE(512, 332); b.writeUInt32LE(1, 528);
  b.writeUInt16LE(0x14c, 68); // I386 + PE32 + IL-only is the AnyCPU combination.
  const assembly = put('portable.dll', b); assert.equal(binaryKind(assembly), 'managed');
  for (const machine of [0x1c4, 0x8664, 0xaa64, 0]) {
    b.writeUInt16LE(machine, 68); fs.writeFileSync(assembly, b); assert.equal(binaryKind(assembly), 'foreign');
  }
  b.writeUInt16LE(0x14c, 68);
  b.writeUInt32LE(3, 528); fs.writeFileSync(assembly, b); assert.equal(binaryKind(assembly), 'foreign');
  put('unknown-linux', Buffer.from('7f454c46', 'hex')); assert.throws(() => inspectTree(root, () => 'arm64'), /Foreign runtime binary/);
});
