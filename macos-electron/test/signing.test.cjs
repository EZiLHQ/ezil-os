'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { releaseConfig, signArgs, notarize, staple } = require('../scripts/signing.cjs');
test('release requires valid Developer ID and Keychain profile, never silently ad-hoc', () => {
  assert.equal(releaseConfig([], {}, () => {}).identity, '-');
  assert.throws(() => releaseConfig(['--developer-id'], {}, () => {}));
  const env = { EZIL_SIGNING_IDENTITY: 'A'.repeat(40), EZIL_NOTARY_PROFILE: 'ezil-notary' };
  assert.throws(() => releaseConfig(['--developer-id'], env, () => '0 valid identities'));
  const config = releaseConfig(['--developer-id'], env, () => `1) ${env.EZIL_SIGNING_IDENTITY} "Developer ID Application: EZiL (TEAM)"`);
  const args = signArgs(config, '/build/App.app');
  assert.ok(args.includes('runtime')); assert.ok(args.includes('--timestamp')); assert.ok(!args.includes('-'));
  const calls = [], run = (bin, args) => { calls.push([bin, args]); return '{"status":"Accepted"}'; };
  notarize('/build/App.zip', config, run); staple('/build/App.app', run);
  assert.equal(calls.length, 3); assert.ok(calls[0][1].includes('--keychain-profile'));
  assert.throws(() => notarize('/build/App.zip', config, () => '{"status":"Invalid"}'));
  assert.throws(() => notarize('/build/App.zip', { release: false }, run));
});
