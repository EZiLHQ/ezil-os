'use strict';
const path = require('node:path');
// A release never falls back to ad-hoc signing. Secrets stay in Keychain;
// only an identity fingerprint and notarytool profile name enter the build.
function releaseConfig(args, env, run) {
  if (args.length === 0) return { release: false, identity: '-' };
  if (args.length !== 1 || args[0] !== '--developer-id') throw Error('Expected --developer-id or no arguments for an internal build');
  const identity = env.EZIL_SIGNING_IDENTITY, profile = env.EZIL_NOTARY_PROFILE;
  if (!/^[A-Fa-f0-9]{40}$/.test(identity || '') || !/^[A-Za-z0-9_.-]{1,100}$/.test(profile || '')) throw Error('Set EZIL_SIGNING_IDENTITY fingerprint and EZIL_NOTARY_PROFILE Keychain profile');
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { stdio: 'pipe', encoding: 'utf8' });
  if (!identities.split('\n').some(line => line.toUpperCase().includes(identity.toUpperCase()) && /"Developer ID Application:/.test(line))) throw Error('Valid Developer ID Application identity required');
  return { release: true, identity, profile };
}
function signArgs(config, file) {
  return ['--force', '--sign', config.identity, ...(config.release ? ['--options', 'runtime', '--timestamp', '--entitlements', path.join(__dirname, '../entitlements.plist')] : ['--preserve-metadata=entitlements']), file];
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
module.exports = { releaseConfig, signArgs, notarize, staple };
