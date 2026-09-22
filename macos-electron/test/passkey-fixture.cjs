'use strict';
// Disposable relying-party fixture, never a production login backend. All
// users/credentials are synthetic; no authenticator secrets are persisted.
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { randomBytes, createHash, createPublicKey, verify } = require('node:crypto');
function verifyAssertion(value, credential, { challenge, origin, rpId }) {
  const client = Buffer.from(value.clientDataJSON, 'base64url'), data = JSON.parse(client);
  if (data.type !== 'webauthn.get' || data.challenge !== challenge || data.origin !== origin || data.crossOrigin === true || value.id !== credential.id) throw Error('client_data_rejected');
  const auth = Buffer.from(value.authenticatorData, 'base64url');
  if (auth.length < 37 || !auth.subarray(0, 32).equals(createHash('sha256').update(rpId).digest()) || (auth[32] & 5) !== 5) throw Error('authenticator_data_rejected');
  const counter = auth.readUInt32BE(33);
  if (counter <= credential.counter) throw Error('counter_rejected');
  const signed = Buffer.concat([auth, createHash('sha256').update(client).digest()]);
  if (!verify('sha256', signed, credential.publicKey, Buffer.from(value.signature, 'base64url'))) throw Error('signature_rejected');
  return counter;
}
async function startFixture() {
  let origin, credential;
  const challenges = new Map(), results = { registrations: 0, assertions: 0 };
  const server = http.createServer(async (req, res) => {
    const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    try {
      const route = new URL(req.url, origin).pathname;
      if (req.method === 'GET' && ['/', '/second', '/popup'].includes(route)) {
        res.setHeader('Content-Type', 'text/html'); res.end(fs.readFileSync(path.join(__dirname, 'fixtures/passkeys.html'))); return;
      }
      if (req.method !== 'POST' || req.headers.origin !== origin || !['/options', '/verify'].includes(route)) { res.statusCode = 403; json({ error: 'rejected' }); return; }
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 32768) throw Error('too_large'); }
      const value = JSON.parse(body);
      if (route === '/options') {
        const challenge = randomBytes(32).toString('base64url');
        challenges.set(challenge, { action: value.action, time: Date.now() });
        json({ challenge, rpId: value.action === 'wrong-rp' ? 'unrelated.invalid' : 'localhost',
          ...(credential ? { credentialId: credential.id } : {}) }); return;
      }
      const client = JSON.parse(Buffer.from(value.clientDataJSON, 'base64url'));
      const pending = challenges.get(client.challenge); challenges.delete(client.challenge);
      if (!pending || Date.now() - pending.time > 60000 || client.origin !== origin || client.crossOrigin === true) throw Error('challenge_rejected');
      if (pending.action === 'register') {
        if (client.type !== 'webauthn.create' || value.algorithm !== -7) throw Error('registration_rejected');
        const auth = Buffer.from(value.authenticatorData, 'base64url');
        if (auth.length < 55 || !auth.subarray(0, 32).equals(createHash('sha256').update('localhost').digest()) || (auth[32] & 0x45) !== 0x45) throw Error('registration_flags_rejected');
        const id = auth.subarray(55, 55 + auth.readUInt16BE(53)).toString('base64url');
        if (id !== value.id) throw Error('credential_id_rejected');
        credential = { id, publicKey: createPublicKey({ key: Buffer.from(value.publicKey, 'base64url'), type: 'spki', format: 'der' }), counter: auth.readUInt32BE(33) };
        results.registrations++; json({ verified: true }); return;
      }
      if (!credential || !['authenticate', 'discover'].includes(pending.action)) throw Error('no_registration');
      credential.counter = verifyAssertion(value, credential, { challenge: client.challenge, origin, rpId: 'localhost' });
      results.assertions++; json({ verified: true });
    } catch { res.statusCode = 400; json({ error: 'verification_failed' }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://localhost:${server.address().port}`;
  return { origin, results, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
module.exports = { startFixture, verifyAssertion };
