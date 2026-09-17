'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validSignature, argv, cleanEnvironment, discover } = require('../src/vscode.cjs');
const details = 'Identifier=com.microsoft.VSCode\nAuthority=Developer ID Application: Microsoft Corporation (UBF8T346G9)\nTeamIdentifier=UBF8T346G9\n';
test('verifier requires Microsoft bundle, team and Developer ID identity together', () => {
  assert.ok(validSignature('com.microsoft.VSCode', details));
  assert.equal(validSignature('com.evil.editor', details), false);
  for (const needle of ['UBF8T346G9', 'com.microsoft.VSCode', 'Microsoft Corporation']) assert.equal(validSignature('com.microsoft.VSCode', details.replaceAll(needle, 'bad')), false);
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
