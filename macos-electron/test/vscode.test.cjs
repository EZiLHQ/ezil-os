'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validSignature, supportedVersion, argv, cleanEnvironment, editorEnvironment, discover } = require('../src/vscode.cjs');
const details = 'Identifier=com.microsoft.VSCode\nAuthority=Developer ID Application: Microsoft Corporation (UBF8T346G9)\nTeamIdentifier=UBF8T346G9\n';
test('verifier requires Microsoft bundle, team and Developer ID identity together', () => {
  assert.ok(validSignature('com.microsoft.VSCode', details));
  assert.equal(validSignature('com.evil.editor', details), false);
  for (const needle of ['UBF8T346G9', 'com.microsoft.VSCode', 'Microsoft Corporation']) assert.equal(validSignature('com.microsoft.VSCode', details.replaceAll(needle, 'bad')), false);
  assert.equal(supportedVersion('1.108.2'), false); assert.equal(supportedVersion('1.109.0'), true); assert.equal(supportedVersion('2.0.0'), true); assert.equal(supportedVersion('bad'), false);
  assert.equal(discover({ platform: 'linux' }), null);
});
test('launch argv keeps workspace as literal argument and app-owned editor dirs', () => {
  const w = { files: '/tmp/a $(touch nope); space', editorData: '/tmp/owner/data', extensions: '/tmp/owner/extensions' };
  assert.deepEqual(argv(w), ['--new-window', '--user-data-dir', w.editorData, '--extensions-dir', w.extensions, w.files]);
  assert.throws(() => argv({ ...w, files: '--extensions-dir' }));
  process.env.EZIL_NATIVE_ADMIN_CAPABILITY = 'private'; process.env.AZURE_API_KEY = 'private';
  const env = cleanEnvironment(); assert.equal(env.EZIL_NATIVE_ADMIN_CAPABILITY, undefined); assert.equal(env.AZURE_API_KEY, undefined);
  delete process.env.EZIL_NATIVE_ADMIN_CAPABILITY; delete process.env.AZURE_API_KEY;
});
test('editor environment accepts only private absolute descriptor files', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-editor-env-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const connector = path.join(root, 'connector.json'), model = path.join(root, 'model.json');
  fs.writeFileSync(connector, '{}', { mode: 0o600 }); fs.writeFileSync(model, '{}', { mode: 0o600 });
  const env = editorEnvironment({ connector, model });
  assert.equal(env.EZIL_BROKER_FILE, connector); assert.equal(env.EZIL_AI_BROKER_FILE, model);
  fs.chmodSync(connector, 0o644); assert.throws(() => editorEnvironment({ connector }));
  assert.throws(() => editorEnvironment({ connector: 'relative.json' }));
});
