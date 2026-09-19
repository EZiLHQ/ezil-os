'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { verifyRuntimeBundle, BUNDLE_PINS } = require('../scripts/verify-bundle.cjs');
test('standalone verifier pins match the actual packaging and editor pins', () => {
  const { CODE_SERVER } = require('../src/editor.cjs');
  const { ezilTools } = require('../package.json');
  assert.equal(BUNDLE_PINS.editor, CODE_SERVER.version);
  assert.equal(BUNDLE_PINS.editorArchiveSHA256, CODE_SERVER.sha256);
  assert.equal(BUNDLE_PINS.bun, ezilTools.bun);
  const source = fs.readFileSync(require.resolve('../scripts/package.cjs'), 'utf8');
  assert.ok(source.indexOf('verifyRuntimeBundle(resources, inventory)') < source.indexOf('signTree(bundle)'));
});
function fixture(t) {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-portability-'))), root = path.join(temp, 'Resources');
  fs.mkdirSync(root); t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const put = (relative, value, mode = 0o600) => {
    const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); fs.chmodSync(file, mode); return file;
  };
  for (const file of ['code-server/bin/code-server', 'code-server/lib/node', 'bun/bun']) put(file, '#!/bin/sh\nexit 0\n', 0o700);
  put('code-server/out/node/entry.js', '// synthetic editor entry');
  put('code-server/package.json', { name: 'code-server', version: BUNDLE_PINS.editor });
  put('code-server/lib/vscode/package.json', { name: 'code-oss', version: '1.115.0' });
  put('code-server/LICENSE', 'Synthetic notice');
  put('native/src/helper.js', 'import fs from "node:fs"; export const ready = true;');
  put('native/package.json', { type: 'module', private: true });
  const closure = { version: 1, dependencyComplete: true, inputs: [{ name: 'native/src/main.ts', bytes: 20, sha256: 'a'.repeat(64) }], external: ['node:fs', 'bun'] };
  put('native/closure.json', closure);
  for (const file of ['bundle.min.js', 'bundle.min.css', 'icons.js']) put(`app/public/os/${file}`, 'synthetic asset');
  put('extensions/ezil-vscode/package.json', { name: 'ezil-native-connector', version: '1.0.0', engines: { vscode: '^1.109.0' }, main: './dist/extension.js' });
  put('extensions/ezil-vscode/dist/extension.js', 'exports.activate = () => {};');
  const metadata = { bun: BUNDLE_PINS.bun, codeServer: { version: BUNDLE_PINS.editor, archiveSHA256: BUNDLE_PINS.editorArchiveSHA256, architecture: 'arm64', nativeFiles: ['lib/node'], licenses: ['LICENSE'] }, inputs: { helper: { path: 'native', files: {} } } };
  const evidence = () => {
    for (const file of ['src/helper.js', 'closure.json', 'package.json']) metadata.inputs.helper.files[file] = createHash('sha256').update(fs.readFileSync(path.join(root, 'native', file))).digest('hex');
    put('INVENTORY.json', metadata);
  };
  evidence(); return { root, temp, put, metadata, closure, evidence };
}
function rejects(root, code, metadata) {
  assert.throws(() => verifyRuntimeBundle(root, metadata), error => {
    assert.equal(error.message, code); assert.equal(error.code, code); assert.equal(error.cause, undefined); assert.ok(!error.message.includes(root)); return true;
  });
}
test('complete Resources verifies from supplied or shipped inventory and remains valid after relocation', t => {
  const f = fixture(t), before = verifyRuntimeBundle(f.root, f.metadata);
  assert.deepEqual(verifyRuntimeBundle(f.root), before); assert.equal(before.helperDependencyClosed, true);
  assert.equal(before.codeServerVersion, BUNDLE_PINS.editor); assert.ok(!JSON.stringify(before).includes(f.temp));
  for (const value of Object.values(before.sha256)) assert.match(value, /^[a-f0-9]{64}$/);
  const relocated = path.join(f.temp, 'Moved Resources'); fs.renameSync(f.root, relocated);
  assert.deepEqual(verifyRuntimeBundle(relocated), before);
  const standalone = path.join(f.temp, 'verify-bundle.cjs'); fs.copyFileSync(require.resolve('../scripts/verify-bundle.cjs'), standalone);
  assert.deepEqual(require(standalone).verifyRuntimeBundle(relocated), before);
});
test('0.0.14-style raw helper layout and absent editor cannot pass', t => {
  const f = fixture(t); fs.rmSync(path.join(f.root, 'code-server'), { recursive: true });
  rejects(f.root, 'bundle_missing_file');
  const g = fixture(t); fs.unlinkSync(path.join(g.root, 'native/src/helper.js'));
  g.put('native/src/main.ts', 'import "../../local/src/boot/os-document.ts";'); rejects(g.root, 'bundle_missing_file');
});
test('every required runtime component and executable permission is enforced', t => {
  for (const file of ['code-server/lib/node', 'bun/bun', 'native/closure.json', 'code-server/out/node/entry.js', 'app/public/os/bundle.min.js', 'app/public/os/bundle.min.css', 'app/public/os/icons.js', 'extensions/ezil-vscode/package.json', 'extensions/ezil-vscode/dist/extension.js']) {
    const f = fixture(t); fs.unlinkSync(path.join(f.root, file)); rejects(f.root, 'bundle_missing_file');
  }
  for (const file of ['code-server/bin/code-server', 'code-server/lib/node', 'bun/bun']) {
    const f = fixture(t); fs.chmodSync(path.join(f.root, file), 0o600); rejects(f.root, 'bundle_not_executable');
  }
});
test('relative internal file, directory, and parent-component symlinks are not escapes', t => {
  const f = fixture(t);
  fs.symlinkSync('../lib/node', path.join(f.root, 'code-server/bin/node'));
  fs.symlinkSync('code-server/lib', path.join(f.root, 'shared-lib'));
  fs.symlinkSync('shared-lib/node', path.join(f.root, 'node-link'));
  fs.symlinkSync('.', path.join(f.root, 'self'));
  assert.equal(verifyRuntimeBundle(f.root).symlinks, 4);
  const moved = path.join(f.temp, 'Moved'); fs.renameSync(f.root, moved); assert.equal(verifyRuntimeBundle(moved).symlinks, 4);
});
test('external links, prefix lookalikes, dangling links and nonrelocatable absolute links are rejected', t => {
  for (const kind of ['external', 'prefix', 'dangling', 'absolute']) {
    const f = fixture(t); let target, code;
    if (kind === 'external') { target = '../outside'; fs.writeFileSync(path.join(f.temp, 'outside'), 'canary'); code = 'bundle_external_symlink'; }
    if (kind === 'prefix') { fs.mkdirSync(f.root + '-other'); target = '../Resources-other'; code = 'bundle_external_symlink'; }
    if (kind === 'dangling') { target = 'missing'; code = 'bundle_broken_symlink'; }
    if (kind === 'absolute') { target = path.join(f.root, 'bun/bun'); code = 'bundle_nonportable_symlink'; }
    fs.symlinkSync(target, path.join(f.root, 'link')); rejects(f.root, code);
  }
});
test('editor pins, native inventory, and helper closure evidence fail closed', t => {
  const addon = fixture(t); addon.put('code-server/lib/addon.node', 'synthetic native object', 0o600); addon.metadata.codeServer.nativeFiles.push('lib/addon.node');
  assert.equal(verifyRuntimeBundle(addon.root, addon.metadata).codeServerVersion, BUNDLE_PINS.editor);
  fs.unlinkSync(path.join(addon.root, 'code-server/lib/addon.node')); rejects(addon.root, 'bundle_missing_file', addon.metadata);
  for (const field of ['version', 'archiveSHA256', 'architecture']) {
    const f = fixture(t); f.metadata.codeServer[field] = 'wrong'; rejects(f.root, 'bundle_editor_pin_mismatch', f.metadata);
  }
  const wrongPackage = fixture(t); wrongPackage.put('code-server/package.json', { version: '4.0.0' }); rejects(wrongPackage.root, 'bundle_editor_pin_mismatch');
  const wrongBun = fixture(t); wrongBun.metadata.bun = '1.0.0'; rejects(wrongBun.root, 'bundle_bun_pin_mismatch', wrongBun.metadata);
  for (const external of ['../../local/src/boot/os-document.ts', '/private/build/helper.js', 'third-party-package', 'node:not-a-real-builtin']) {
    const f = fixture(t); f.closure.external = [external]; f.put('native/closure.json', f.closure); f.evidence(); rejects(f.root, 'bundle_helper_external_dependency');
  }
  const unclosed = fixture(t); unclosed.closure.dependencyComplete = false; unclosed.put('native/closure.json', unclosed.closure); rejects(unclosed.root, 'bundle_helper_not_closed');
  const tampered = fixture(t); tampered.put('native/src/helper.js', 'changed output'); rejects(tampered.root, 'bundle_helper_hash_mismatch');
  const missingEvidence = fixture(t); delete missingEvidence.metadata.inputs.helper; rejects(missingEvidence.root, 'bundle_missing_helper_evidence', missingEvidence.metadata);
});
test('metadata traversal and filesystem errors never expose private paths', t => {
  const f = fixture(t); f.put('extensions/ezil-vscode/package.json', { name: 'fixture', version: '1', engines: { vscode: '*' }, main: '../outside.js' }); rejects(f.root, 'bundle_invalid_relative_path');
  rejects(path.join(f.temp, 'missing-private-location'), 'bundle_unreadable');
});
