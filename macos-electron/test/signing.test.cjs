'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appleCertificateIdentity, releaseConfig, validatePasskeyProfile, preparePasskeySigning, signArgs, notarize, staple } = require('../scripts/signing.cjs');
const testCert = Buffer.from('synthetic signing certificate');
function profileRun(_bin, args) {
  if (args[0] === 'cms') return '<plist>synthetic fixture</plist>';
  const fields = { TeamIdentifier: '<plist><array><string>A1B2C3D4E5</string></array></plist>', 'Entitlements.keychain-access-groups': '<plist><array><string>A1B2C3D4E5.*</string></array></plist>',
    ExpirationDate: '2099-01-01T00:00:00Z', 'Entitlements.com\\.apple\\.application-identifier': 'A1B2C3D4E5.com.ezil.os.native',
    ProvisionsAllDevices: 'true', DeveloperCertificates: `<array><data>${testCert.toString('base64')}</data></array>` };
  return fields[args[1]] || '';
}
test('release requires valid Developer ID and Keychain profile, never silently ad-hoc', () => {
  assert.equal(releaseConfig([], {}, () => {}).identity, '-');
  assert.throws(() => releaseConfig(['--developer-id'], {}, () => {}));
  const env = { EZIL_SIGNING_IDENTITY: 'A'.repeat(40), EZIL_NOTARY_PROFILE: 'ezil-notary' };
  assert.throws(() => releaseConfig(['--developer-id'], env, () => '0 valid identities'));
  const config = releaseConfig(['--developer-id'], env, () => `1) ${env.EZIL_SIGNING_IDENTITY} "Developer ID Application: EZiL (A1B2C3D4E5)"`);
  const args = signArgs(config, '/build/App.app');
  assert.ok(args.includes('runtime')); assert.ok(args.includes('--timestamp')); assert.ok(!args.includes('-'));
  const calls = [], run = (bin, args) => { calls.push([bin, args]); return '{"status":"Accepted"}'; };
  notarize('/build/App.zip', config, run); staple('/build/App.app', run);
  assert.equal(calls.length, 3); assert.ok(calls[0][1].includes('--keychain-profile'));
  assert.throws(() => notarize('/build/App.zip', config, () => '{"status":"Invalid"}'));
  assert.throws(() => notarize('/build/App.zip', { release: false }, run));
});
test('only the main signed app receives its validated passkey keychain group', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-passkey-signing-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bundle = path.join(root, 'App.app'); fs.mkdirSync(path.join(bundle, 'Contents'), { recursive: true });
  const config = { release: true, team: 'A1B2C3D4E5', identity: appleCertificateIdentity(testCert) }, calls = [];
  assert.throws(() => signArgs(config, '/App.app', { mainApp: true }));
  assert.throws(() => preparePasskeySigning(config, bundle, root, profileRun), /provisioning profile/);
  config.passkeyProfile = path.join(root, 'test.provisionprofile'); fs.writeFileSync(config.passkeyProfile, 'synthetic profile');
  preparePasskeySigning(config, bundle, root, (bin, args) => { calls.push([bin, args]); return profileRun(bin, args); });
  const entitlements = fs.readFileSync(config.mainEntitlements, 'utf8');
  assert.match(entitlements, /A1B2C3D4E5\.com\.ezil\.os\.native\.webauthn/);
  assert.match(entitlements, /com.apple.application-identifier/);
  assert.ok(!entitlements.includes('associated-domains') && !entitlements.includes('web-browser.public-key-credential'));
  assert.ok(signArgs(config, '/App.app', { mainApp: true }).includes(config.mainEntitlements));
  const helper = signArgs(config, '/helper');
  assert.ok(!helper.includes(config.mainEntitlements));
  assert.ok(!fs.readFileSync(helper[helper.indexOf('--entitlements') + 1], 'utf8').includes('keychain-access-groups'));
  assert.equal(fs.readFileSync(path.join(bundle, 'Contents/embedded.provisionprofile'), 'utf8'), 'synthetic profile');
  assert.equal(calls.filter(([bin]) => bin.endsWith('PlistBuddy')).length, 1);
  const internal = { release: false, identity: '-' };
  preparePasskeySigning(internal, '/App.app', root, () => assert.fail());
  assert.equal(internal.mainEntitlements, undefined);
  assert.throws(() => preparePasskeySigning({ release: true, team: '$(id)' }, '/App', root, () => {}));
});
test('expired, wrong team, wrong app, unauthorized group/certificate and development profiles fail closed', () => {
  const config = { team: 'A1B2C3D4E5', identity: appleCertificateIdentity(testCert) };
  validatePasskeyProfile('fixture', config, profileRun);
  for (const [field, value] of [['ExpirationDate', '2000-01-01'], ['TeamIdentifier', '["OTHERTEAM1"]'],
    ['Entitlements.com\\.apple\\.application-identifier', 'A1B2C3D4E5.other.app'],
    ['Entitlements.keychain-access-groups', '["OTHERTEAM1.*"]'], ['DeveloperCertificates', '<array/>'], ['ProvisionsAllDevices', 'false']]) {
    assert.throws(() => validatePasskeyProfile('fixture', config, (bin, args) => args[1] === field ? value : profileRun(bin, args)));
  }
});
test('profile field extraction matches real macOS plutil semantics', { skip: process.platform !== 'darwin' }, () => {
  const { execFileSync } = require('node:child_process');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
    <key>TeamIdentifier</key><array><string>A1B2C3D4E5</string></array>
    <key>ExpirationDate</key><date>2099-01-01T00:00:00Z</date><key>ProvisionsAllDevices</key><true/>
    <key>DeveloperCertificates</key><array><data>${testCert.toString('base64')}</data></array>
    <key>Entitlements</key><dict><key>com.apple.application-identifier</key><string>A1B2C3D4E5.com.ezil.os.native</string>
    <key>keychain-access-groups</key><array><string>A1B2C3D4E5.*</string></array></dict></dict></plist>`;
  validatePasskeyProfile(xml, { team: 'A1B2C3D4E5', identity: appleCertificateIdentity(testCert) }, execFileSync);
});
