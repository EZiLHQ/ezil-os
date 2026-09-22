'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { atomic } = require('../src/files.cjs');
const { BUNDLE_ID } = require('../src/passkeys.cjs');
// A release never falls back to ad-hoc signing. Secrets stay in Keychain;
// only an identity fingerprint and notarytool profile name enter the build.
function releaseConfig(args, env, run) {
  if (args.length === 0) return { release: false, identity: '-' };
  if (args.length !== 1 || args[0] !== '--developer-id') throw Error('Expected --developer-id or no arguments for an internal build');
  const identity = env.EZIL_SIGNING_IDENTITY, profile = env.EZIL_NOTARY_PROFILE;
  if (!/^[A-Fa-f0-9]{40}$/.test(identity || '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(profile || '')) throw Error('Set EZIL_SIGNING_IDENTITY fingerprint and EZIL_NOTARY_PROFILE Keychain profile');
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { stdio: 'pipe', encoding: 'utf8' });
  const line = identities.split('\n').find(line => line.toUpperCase().includes(identity.toUpperCase()) && /"Developer ID Application:/.test(line));
  const team = line?.match(/\(([A-Z0-9]{10})\)"\s*$/)?.[1];
  if (!team) throw Error('Valid Developer ID Application identity and Team ID required');
  return { release: true, identity, profile, team, passkeyProfile: env.EZIL_PASSKEY_PROVISION_PROFILE };
}
function validatePasskeyProfile(xml, config, run, now = Date.now()) {
  const extract = (key, format = 'raw') => run('/usr/bin/plutil', ['-extract', key, format, '-o', '-', '-'], { input: xml, encoding: 'utf8', stdio: 'pipe' }).trim();
  const entitlement = key => `Entitlements.${key.replaceAll('.', '\\.')}`;
  const teams = JSON.parse(extract('TeamIdentifier', 'json'));
  const groups = JSON.parse(extract(entitlement('keychain-access-groups'), 'json'));
  const appId = `${config.team}.${BUNDLE_ID}`, group = `${appId}.webauthn`;
  const expiration = Date.parse(extract('ExpirationDate'));
  const certs = [...extract('DeveloperCertificates', 'xml1').matchAll(/<data>\s*([A-Za-z0-9+/=\s]+)<\/data>/g)];
  if (!Array.isArray(teams) || !teams.includes(config.team) || !Number.isFinite(expiration) || expiration <= now
      || extract(entitlement('com.apple.application-identifier')) !== appId
      || !Array.isArray(groups) || !groups.some(value => value === group || value === `${config.team}.*`)
      || extract('ProvisionsAllDevices') !== 'true'
      || !certs.some(match => createHash('sha1').update(Buffer.from(match[1].replace(/\s/g, ''), 'base64')).digest('hex').toUpperCase() === config.identity.toUpperCase())) {
    throw Error('Passkey provisioning profile must authorize this Developer ID identity, app, team and keychain group and must not be expired');
  }
}
function preparePasskeySigning(config, bundle, build, run) {
  if (!config.release) return;
  if (!/^[A-Z0-9]{10}$/.test(config.team || '')) throw Error('Passkey signing requires a validated Team ID');
  if (!config.passkeyProfile || !path.isAbsolute(config.passkeyProfile)) throw Error('Set EZIL_PASSKEY_PROVISION_PROFILE to the authorized Developer ID provisioning profile; adding restricted entitlements without it can prevent launch');
  const profileBytes = fs.readFileSync(config.passkeyProfile);
  if (!profileBytes.length || profileBytes.length > 1024 * 1024) throw Error('Invalid provisioning profile size');
  // Decode exactly the bytes embedded below, avoiding a replaced input file.
  const xml = run('/usr/bin/security', ['cms', '-D'], { input: profileBytes, encoding: 'utf8', stdio: 'pipe' });
  validatePasskeyProfile(xml, config, run);
  const group = `${config.team}.${BUNDLE_ID}.webauthn`;
  const base = fs.readFileSync(path.join(__dirname, '../entitlements.plist'), 'utf8');
  config.mainEntitlements = path.join(build, 'main-entitlements.plist');
  atomic(config.mainEntitlements, base.replace('</dict>', `<key>com.apple.application-identifier</key><string>${config.team}.${BUNDLE_ID}</string>\n<key>keychain-access-groups</key><array><string>${group}</string></array>\n</dict>`));
  atomic(path.join(bundle, 'Contents/embedded.provisionprofile'), profileBytes);
  run('/usr/libexec/PlistBuddy', ['-c', `Add :EZiLWebAuthnKeychainAccessGroup string ${group}`, path.join(bundle, 'Contents/Info.plist')]);
}
function signArgs(config, file, { mainApp = false } = {}) {
  if (config.release && mainApp && !config.mainEntitlements) throw Error('Main app passkey entitlements were not prepared');
  return ['--force', '--sign', config.identity, ...(config.release ? ['--options', 'runtime', '--timestamp', '--entitlements', mainApp ? config.mainEntitlements : path.join(__dirname, '../entitlements.plist')] : ['--preserve-metadata=entitlements']), file];
}
function notarize(file, config, run) {
  if (!config.release) throw Error('Notarization requires release configuration');
  const result = JSON.parse(run('/usr/bin/xcrun', ['notarytool', 'submit', file, '--keychain-profile', config.profile, '--wait', '--output-format', 'json'], { stdio: 'pipe', encoding: 'utf8' }));
  if (result.status !== 'Accepted') throw Error('Apple notarization was not accepted; inspect submission in notarytool');
}
function staple(file, run) {
  run('/usr/bin/xcrun', ['stapler', 'staple', file]);
  run('/usr/bin/xcrun', ['stapler', 'validate', file]);
}
module.exports = { releaseConfig, validatePasskeyProfile, preparePasskeySigning, signArgs, notarize, staple };
