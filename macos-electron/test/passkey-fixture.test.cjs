'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { generateKeyPairSync, createHash, sign } = require('node:crypto');
const { verifyAssertion } = require('./passkey-fixture.cjs');
test('fixture verifies signatures, origin, RP, challenge, UV/UP and counter; tampering is rejected', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const expected = { challenge: 'synthetic_challenge', origin: 'http://localhost:3000', rpId: 'localhost' };
  const credential = { id: 'synthetic_id', publicKey, counter: 0 };
  const auth = Buffer.alloc(37); createHash('sha256').update('localhost').digest().copy(auth); auth[32] = 5; auth.writeUInt32BE(1, 33);
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', origin: expected.origin, challenge: expected.challenge }));
  const value = { id: credential.id, authenticatorData: auth.toString('base64url'), clientDataJSON: client.toString('base64url'),
    signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey).toString('base64url') };
  assert.equal(verifyAssertion(value, credential, expected), 1);
  for (const patch of [{ challenge: 'wrong' }, { origin: 'https://wrong.invalid' }, { rpId: 'wrong.invalid' }]) assert.throws(() => verifyAssertion(value, credential, { ...expected, ...patch }));
  assert.throws(() => verifyAssertion(value, { ...credential, counter: 1 }, expected));
  for (const patch of [{ id: 'wrong' }, { signature: 'AA' }, { authenticatorData: 'AA' }]) assert.throws(() => verifyAssertion({ ...value, ...patch }, credential, expected));
  for (const flags of [0, 1, 4]) { const modified = Buffer.from(auth); modified[32] = flags; assert.throws(() => verifyAssertion({ ...value, authenticatorData: modified.toString('base64url') }, credential, expected)); }
});
