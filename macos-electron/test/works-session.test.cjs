'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Vault, credential } = require('../src/broker.cjs');
const { configureProvider } = require('../src/prompts.cjs');
const { WORKS_ORIGIN, GATEWAY_ORIGIN, fixedFetch, catalog, WorksSession } = require('../src/works-session.cjs');
const { fixture, MemoryVault, grant, session, accountId, now, modelList } = require('./works-fixture.cjs');

test('Works sign-in, live builder/member checks, fixed origins and token-free status', async () => {
  const f = fixture(undefined, new MemoryVault({ provider: 'ezil', session: null }));
  await f.works.signIn('builder@example.test', 'synthetic-password');
  assert.deepEqual(f.calls.map(c => c.url), [WORKS_ORIGIN + '/auth/signin', WORKS_ORIGIN + '/v1/me', GATEWAY_ORIGIN + '/v1/models']);
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { email: 'builder@example.test', password: 'synthetic-password' });
  for (const { options } of f.calls) { assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit'); assert.ok(options.signal); }
  assert.deepEqual(f.vault.get(), { provider: 'ezil', session: { ...session, worksOrigin: WORKS_ORIGIN, gatewayOrigin: GATEWAY_ORIGIN } });
  const status = await f.works.status();
  assert.deepEqual(status, { configured: true, provider: 'ezil', state: 'ready', models: ['ezil-fast', 'ezil-code'] });
  for (const secret of [grant.accessToken, grant.refreshToken, 'synthetic-password', accountId]) assert.equal(JSON.stringify(status).includes(secret), false);
});
test('missing sessions and cancelled native sign-in cannot use a previously selected Azure provider', async () => {
  const f = fixture(undefined, new MemoryVault({ provider: 'azure', endpoint: 'https://test.openai.azure.com/', key: 'synthetic-key', deployment: 'test' }));
  await assert.rejects(configureProvider('ezil', f.vault, f.works, async () => { throw Error('cancelled'); }));
  assert.deepEqual(f.vault.get(), { provider: 'ezil', session: null });
  await assert.rejects(f.works.inspect(), { code: 'signin_required' }); assert.equal(f.calls.length, 0);
});
test('native Works password is hidden and passed only to main session code', async () => {
  const f = fixture(); const prompts = [];
  await configureProvider('ezil', f.vault, f.works, async (label, hidden) => { prompts.push({ label, hidden }); return hidden ? 'synthetic-password' : 'builder@example.test'; });
  assert.deepEqual(prompts, [{ label: 'Works builder email', hidden: undefined }, { label: 'Works password', hidden: true }]);
  assert.equal(JSON.stringify(f.vault.writes).includes('synthetic-password'), false);
});
test('concurrent expiry refreshes once, consumes old token before network, persists rotation', async () => {
  const vault = new MemoryVault({ provider: 'ezil', session: { ...session, expiresAt: now + 10 } });
  const f = fixture((url, options) => {
    if (url.endsWith('/auth/refresh')) {
      assert.equal(vault.get().session, null);
      assert.deepEqual(JSON.parse(options.body), { refreshToken: grant.refreshToken });
      return Response.json({ ...grant, accessToken: 'new.header.signature', refreshToken: 'rotated-token' });
    }
    if (url.endsWith('/v1/me') || url.endsWith('/v1/models')) assert.equal(options.headers.Authorization, 'Bearer new.header.signature');
  }, vault);
  await Promise.all([f.works.inspect(), f.works.inspect()]);
  assert.equal(f.calls.filter(c => c.url.endsWith('/auth/refresh')).length, 1);
  assert.equal(vault.get().session.refreshToken, 'rotated-token');
});
test('ambiguous/invalid refresh cannot reuse its token, including after restart', async () => {
  for (const response of [() => { throw Error('secret network payload'); }, () => Response.json({ error: 'synthetic-secret' }, { status: 401 }), () => Response.json({ ...grant, accountId: '22222222-2222-4222-8222-222222222222' }), () => Response.json({ ...grant, expiresIn: -1 })]) {
    const vault = new MemoryVault({ provider: 'ezil', session: { ...session, expiresAt: now } });
    const f = fixture(() => response(), vault);
    await assert.rejects(f.works.inspect(), { code: 'signin_required' });
    assert.equal(vault.get().session, null);
    await assert.rejects(new WorksSession(vault, { fetchImpl: f.fetchImpl }).inspect());
    assert.equal(f.calls.length, 1);
  }
});
test('sign-out or provider switch during refresh cannot resurrect the session', async () => {
  for (const action of [v => v.remove(), v => v.set({ provider: 'ezil', session: null }), v => v.set({ provider: 'bedrock', model: 'test', region: 'us-east-1', token: 'synthetic-token' })]) {
    let release; const pending = new Promise(resolve => { release = resolve; });
    const vault = new MemoryVault({ provider: 'ezil', session: { ...session, expiresAt: now } });
    const f = fixture(() => pending, vault); const request = f.works.inspect();
    action(vault); const selected = vault.get(); release(Response.json(grant));
    await assert.rejects(request, { code: 'signin_required' }); assert.deepEqual(vault.get(), selected);
  }
});
test('rotation disk failure leaves an empty session', async () => {
  const vault = new MemoryVault({ provider: 'ezil', session: { ...session, expiresAt: now } });
  const set = vault.set.bind(vault); vault.set = value => { if (value.session) throw Error('disk failure'); set(value); };
  const f = fixture(undefined, vault); await assert.rejects(f.works.inspect()); assert.equal(vault.get().session, null);
});
test('builder database row, account binding and current AI membership are required', async () => {
  for (const me of [{ accountId, role: 'creator', onboarded: true }, { accountId, role: 'builder', onboarded: false }, { accountId: 'other', role: 'builder', onboarded: true }, {}]) {
    const f = fixture(url => url.endsWith('/v1/me') ? Response.json(me) : undefined);
    await assert.rejects(f.works.inspect(), { code: 'builder_required' }); assert.equal(f.calls.length, 1);
  }
  const f = fixture(url => url.endsWith('/v1/models') ? Response.json({ error: { code: 'account_suspended', message: 'secret' } }, { status: 403 }) : undefined);
  await assert.rejects(f.works.inspect(), { code: 'membership_required' });
  assert.equal((await f.works.status()).state, 'unavailable');
});
test('401 clears the session without retry; service failures and malformed replies fail closed', async () => {
  for (const reply of [() => new Response('secret', { status: 401 }), () => Response.json({ ...modelList, killswitch: 'false' }), () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }), () => new Response('{')]) {
    const f = fixture(url => url.endsWith('/v1/models') ? reply() : undefined);
    await assert.rejects(f.works.inspect()); assert.equal(f.calls.length, 2);
  }
  const f = fixture(url => url.endsWith('/v1/me') ? new Response('', { status: 401 }) : undefined);
  await assert.rejects(f.works.inspect()); assert.equal(f.vault.get().session, null); assert.equal(f.calls.length, 1);
});
test('dynamic catalogs validate every row and preserve minimum/default with bounded caps', () => {
  assert.deepEqual(catalog({ ...modelList, killswitch: true }), { paused: true, models: [] });
  const third = { ...modelList.data[0], id: 'ezil-third', min_output_tokens: 32, default_output_tokens: 128, capabilities: { tools: true, structured_output: true, reasoning: true } };
  const result = catalog({ ...modelList, data: [...modelList.data, third] });
  assert.equal(result.models[2].id, third.id);
  assert.equal(result.models[2].defaultOutputTokens, 128);
  assert.equal(result.models[2].minOutputTokens, 32);
  assert.equal(result.models[2].capabilities.tools, false);
  assert.equal(catalog({ ...modelList, data: [{ ...third, enabled: false }] }).models.length, 0);
  assert.equal(catalog({ ...modelList, data: [{ ...third, supported_api_formats: ['chat_completions'] }] }).models.length, 0);
  assert.equal(catalog({ ...modelList, data: [{ ...third, max_output_tokens: 99999 }] }).models[0].maxOutputTokens, 8192);
  for (const row of [{ id: 'unknown' }, { ...third, id: '../bad' }, { ...third, enabled: 'true' }, { ...third, max_input_tokens: Infinity }, { ...third, default_output_tokens: 1 }, { ...third, min_output_tokens: 99999 }, { ...third, capabilities: { tools: 'true' } }, { ...third, supported_api_formats: ['invalid'] }]) {
    assert.throws(() => catalog({ ...modelList, data: [row] }));
    assert.throws(() => catalog({ ...modelList, killswitch: true, data: [row] }));
  }
  assert.throws(() => catalog({ ...modelList, object: 'bad' }));
  assert.throws(() => catalog({ ...modelList, data: [third, third] }));
});
test('no configurable or redirected credential destination', async () => {
  let calls = 0;
  for (const url of ['http://ai.ezil.work/v1/responses', GATEWAY_ORIGIN + '.evil/v1/models', WORKS_ORIGIN + '/v1/me?redirect=evil', 'https://user:pass@ai.ezil.work/v1/models']) await assert.rejects(fixedFetch(async () => { calls++; }, url, {}));
  assert.equal(calls, 0);
  await assert.rejects(fixedFetch(async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } }), GATEWAY_ORIGIN + '/v1/models', {}));
  assert.throws(() => credential({ provider: 'ezil', session, endpoint: 'https://evil.test' }));
});
test('Vault encrypts synthetic sessions, enforces private regular storage and requires Keychain', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-vault-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = { isEncryptionAvailable: () => false, encryptString: text => Buffer.from(text).map(byte => byte ^ 0xff), decryptString: bytes => Buffer.from(bytes).map(byte => byte ^ 0xff).toString() };
  const vault = new Vault(root, storage);
  assert.throws(() => vault.set({ provider: 'ezil', session }), /Keychain/);
  vault.check = () => {}; // Synthetic crypto only; no real keychain accessed.
  vault.set({ provider: 'ezil', session });
  assert.equal(fs.statSync(vault.file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(vault.file).includes(Buffer.from(grant.refreshToken)), false);
  assert.deepEqual(vault.get(), { provider: 'ezil', session });
  fs.chmodSync(vault.file, 0o644); assert.throws(() => vault.get()); fs.chmodSync(vault.file, 0o600);
  fs.linkSync(vault.file, path.join(root, 'hardlink')); assert.throws(() => vault.get());
});
test('host origin changes never forward legacy or explicitly bound production sessions', async () => {
  for (const bound of [session, { ...session, worksOrigin: WORKS_ORIGIN, gatewayOrigin: GATEWAY_ORIGIN }]) {
    for (const expiresAt of [now, now + 3600000]) {
      for (const change of [{ worksOrigin: 'https://works.stage.test' }, { gatewayOrigin: 'https://gateway.stage.test' }]) {
        let calls = 0;
        const vault = new MemoryVault({ provider: 'ezil', session: { ...bound, expiresAt } });
        const works = new WorksSession(vault, { ...change, now: () => now, fetchImpl: async () => { calls++; throw Error('unexpected'); } });
        await assert.rejects(works.inspect(), { code: 'signin_required' });
        assert.equal(calls, 0); assert.equal(vault.get().session.refreshToken, session.refreshToken);
      }
    }
  }
});
test('fresh staging sign-in and refresh persist both immutable service bindings', async () => {
  const binding = { worksOrigin: 'https://works.stage.test', gatewayOrigin: 'https://gateway.stage.test' };
  const vault = new MemoryVault({ provider: 'ezil', session: null }); const calls = [];
  const works = new WorksSession(vault, { ...binding, now: () => now, fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.redirect, 'error');
    if (url.endsWith('/auth/signin') || url.endsWith('/auth/refresh')) return Response.json(grant);
    if (url.endsWith('/v1/me')) return Response.json({ accountId, role: 'builder', onboarded: true });
    return Response.json(modelList);
  } });
  await works.signIn('builder@example.test', 'synthetic-password');
  assert.deepEqual(vault.get().session, { ...session, ...binding });
  vault.set({ provider: 'ezil', session: { ...vault.get().session, expiresAt: now } });
  await works.inspect(); assert.deepEqual(vault.get().session, { ...session, ...binding });
  assert.ok(calls.every(url => url.startsWith(binding.worksOrigin + '/') || url.startsWith(binding.gatewayOrigin + '/')));
  let leaked = false;
  await assert.rejects(new WorksSession(vault, { fetchImpl: async () => { leaked = true; }, now: () => now }).inspect(), { code: 'signin_required' });
  assert.equal(leaked, false);
  for (const worksOrigin of ['http://works.stage.test', 'https://works.stage.test/path', 'https://u:p@works.stage.test', 'https://works.stage.test?x=1']) assert.throws(() => new WorksSession(vault, { worksOrigin }));
});
