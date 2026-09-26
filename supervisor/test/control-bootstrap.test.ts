import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { validateControlBootstrap, controlSecretIdentity, type ControlBootstrapAuthorization } from '../src/control-bootstrap-contract.js';
import type { Provisioning } from '../src/configuration-delivery-contract.js';
import { fetchControlKey } from '../src/aws-control-key.js';

function fixture() {
    const host: Provisioning = { schemaVersion: 1, accountId: '123456789012', region: 'us-east-1', namespace: 'pilot', bucket: 'ezil-pilot-config',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc',
        scope: { computerId: randomUUID(), computerGeneration: 2, providerInstanceId: 'i-0123456789abcdef0',
            dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() } };
    const id = randomUUID(), now = Math.floor(Date.now() / 1000);
    const authority: ControlBootstrapAuthorization = { schemaVersion: 1, authorizationId: randomUUID(), mountAuthorizationId: randomUUID(),
        controlDomain: 'control.example.com', secretVersionId: randomUUID(), issuedAt: now, expiresAt: now + 300,
        configuration: { schemaVersion: 1, operation: 'prepare', configurationId: id, scope: host.scope, revision: 1, digest: 'a'.repeat(64),
            object: { bucket: host.bucket, key: `pilot/computers/${host.scope.computerId}/generations/2/configurations/${id}.json`,
                versionId: 'version-1', sha256: 'a'.repeat(64), bytes: 100 } } };
    return { host, authority, input: { schemaVersion: 1, authorizationId: authority.authorizationId } };
}
test('startup requests carry only an authority ID; full protected authorization is scoped, strict and expires', () => {
    const { host, authority, input } = fixture();
    assert.deepEqual(validateControlBootstrap(input, host, authority), { host, authority });
    for (const value of [{ ...input, keyHex: 'private' }, { ...input, command: 'start anything' }, { ...input, authorizationId: randomUUID() }]) {
        assert.throws(() => validateControlBootstrap(value, host, authority), /^Error: control_bootstrap_invalid$/);
    }
    for (const value of [{ ...authority, expiresAt: authority.issuedAt }, { ...authority, expiresAt: authority.issuedAt + 301 },
        { ...authority, issuedAt: authority.issuedAt + 100 }, { ...authority, secretVersionId: 'AWSCURRENT' },
        { ...authority, controlDomain: 'https://private@example.com' }, { ...authority, controlDomain: '127.0.0.1' },
        { ...authority, configuration: { ...authority.configuration, operation: 'reload' } },
        { ...authority, configuration: { ...authority.configuration, scope: { ...host.scope, fenceToken: randomUUID() } } },
        { ...authority, secret: 'private' }]) {
        assert.throws(() => validateControlBootstrap(input, host, value), /^Error: control_bootstrap_invalid$/);
    }
    assert.throws(() => validateControlBootstrap(input, host, authority, authority.expiresAt * 1000), /control_bootstrap_invalid/);
    assert.throws(() => validateControlBootstrap(input, host, authority, NaN), /control_bootstrap_invalid/);
});

test('Secrets Manager wire pins IMDS identity, regional endpoint, current version and complete binding', async t => {
    const { host, authority } = fixture(), { name, origin } = controlSecretIdentity(host, authority);
    let metadataMismatch = false, calls = 0;
    const server = createServer((req, res) => {
        if (req.url === '/latest/api/token') { assert.equal(req.method, 'PUT'); res.end('fixture-token'); return; }
        assert.equal(req.headers['x-aws-ec2-metadata-token'], 'fixture-token');
        if (req.url === '/latest/dynamic/instance-identity/document') res.end(JSON.stringify({ accountId: host.accountId,
            region: host.region, instanceId: metadataMismatch ? 'i-1123456789abcdef0' : host.scope.providerInstanceId }));
        else if (req.url === '/latest/meta-data/iam/security-credentials/') res.end('FixtureRole');
        else res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: 'private-fixture',
            Token: 'fixture-session', Expiration: new Date(Date.now() + 3600000).toISOString() }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const options = { metadataRequest: ((o, cb) => { assert.equal(o.hostname, '169.254.169.254');
        return request({ ...o, hostname: '127.0.0.1', port: (server.address() as { port: number }).port }, cb); }) as
        NonNullable<NonNullable<Parameters<typeof fetchControlKey>[3]>['metadataRequest']> };
    const binding = { schemaVersion: 1, scope: host.scope, origin, keyHex: '1a'.repeat(32) };
    const good = { Name: name, ARN: `arn:aws:secretsmanager:us-east-1:${host.accountId}:secret:${name}-ABC123`,
        VersionId: authority.secretVersionId, VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify(binding) };
    const changes = [null, { Name: 'foreign' }, { ARN: good.ARN + '-other' }, { ARN: good.ARN.replace(host.accountId, '999999999999') },
        { VersionId: randomUUID() }, { VersionStages: ['AWSPREVIOUS'] }, { SecretBinary: Buffer.from('private').toString('base64') },
        { SecretString: 'private-not-json' }, { SecretString: 'x'.repeat(4097) },
        ...[{ ...binding, keyHex: 'private' }, { ...binding, origin: 'https://foreign.example.com' },
            { ...binding, scope: { ...host.scope, computerId: randomUUID() } }, { ...binding, scope: { ...host.scope, computerGeneration: 3 } },
            { ...binding, scope: { ...host.scope, fenceToken: randomUUID() } },
            { ...binding, scope: { ...host.scope, providerInstanceId: 'i-1123456789abcdef0' } },
            { ...binding, scope: { ...host.scope, dataVolumeId: 'vol-1123456789abcdef0' } }, { ...binding, extra: true }]
            .map(value => ({ SecretString: JSON.stringify(value) }))];
    for (const change of changes) {
        const handler = { handle: async (req: { hostname: string; headers: Record<string, string>; body?: unknown }) => {
            calls++; assert.equal(req.hostname, 'secretsmanager.us-east-1.amazonaws.com');
            assert.match(req.headers.authorization!, /^AWS4-HMAC-SHA256 /);
            const body = typeof req.body === 'string' ? req.body : Buffer.from(req.body as Uint8Array).toString();
            assert.deepEqual(JSON.parse(body), { SecretId: name, VersionId: authority.secretVersionId, VersionStage: 'AWSCURRENT' });
            return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' },
                body: Readable.from([JSON.stringify({ ...good, ...change })]) } };
        } };
        const fetch = () => fetchControlKey(host, authority, new AbortController().signal, { ...options, requestHandler: handler });
        if (change) await assert.rejects(fetch(), /^Error: control_key_unavailable$/);
        else { const key = await fetch(); assert.deepEqual(key, Buffer.from(binding.keyHex, 'hex')); key.fill(0); }
    }
    assert.equal(calls, changes.length);
    await assert.rejects(fetchControlKey(host, authority, new AbortController().signal, { ...options, requestHandler: {
        handle: async () => { calls++; return { response: { statusCode: 503, headers: { 'content-type': 'application/x-amz-json-1.1' },
            body: Readable.from([JSON.stringify({ __type: 'InternalServiceError', message: 'PRIVATE-FIXTURE' })]) } }; },
    } }), /^Error: control_key_unavailable$/);
    assert.equal(calls, changes.length + 1); metadataMismatch = true;
    await assert.rejects(fetchControlKey(host, authority, new AbortController().signal, options), /^Error: control_key_unavailable$/);
    assert.equal(calls, changes.length + 1);
    const cancelled = AbortSignal.abort();
    await assert.rejects(fetchControlKey(host, authority, cancelled, options), /^Error: control_key_unavailable$/);
});
