import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { instanceCredentials, type MetadataRequest } from '../src/aws-host-identity.js';
import { canonicalJson } from '../src/control-protocol.js';
import { validateConfiguration, validateDelivery, type Provisioning, type Delivery } from '../src/configuration-delivery-contract.js';
import { fetchConfiguration } from '../src/aws-configuration-source.js';

function record() {
    const host: Provisioning = { schemaVersion: 1, accountId: '123456789012', region: 'us-east-1', namespace: 'pilot', bucket: 'ezil-pilot-config',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc',
        scope: { computerId: randomUUID(), computerGeneration: 2, providerInstanceId: 'i-0123456789abcdef0',
            dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() } };
    const bytes = Buffer.from(canonicalJson({ schemaVersion: 1, computerId: host.scope.computerId, computerGeneration: 2,
        configurationRevision: 7, volumeId: host.scope.dataVolumeId, suspended: true, preparedInstallations: [], approvedInstallations: [],
        dataRoot: '/srv/ezil-data', stateDirectory: '/var/lib/ezil-supervisor', stagingRoot: '/run/ezil-supervisor/mounts', controlPort: 8181, memoryBudgetMiB: 3072 }));
    const id = randomUUID(), digest = createHash('sha256').update(bytes).digest('hex');
    const delivery: Delivery = { schemaVersion: 1, configurationId: id, operation: 'prepare', scope: structuredClone(host.scope), revision: 7, digest,
        object: { bucket: host.bucket, key: `pilot/computers/${host.scope.computerId}/generations/2/configurations/${id}.json`,
            versionId: 'version-1', sha256: digest, bytes: bytes.length } };
    return { host, bytes, delivery };
}
async function metadata(t: TestContext, host: Provisioning, fault = '') {
    const paths: string[] = [];
    const server = createServer((req, res) => {
        paths.push(req.url!);
        if (fault === 'redirect') { res.writeHead(302, { location: 'http://evil.invalid' }); res.end(); return; }
        if (fault === 'oversized') { res.end('x'.repeat(32769)); return; }
        if (fault === 'hang') return;
        if (req.url === '/latest/api/token') {
            assert.equal(req.method, 'PUT'); assert.equal(req.headers['x-aws-ec2-metadata-token-ttl-seconds'], '60');
            res.end('private-metadata-token'); return;
        }
        assert.equal(req.headers['x-aws-ec2-metadata-token'], 'private-metadata-token');
        if (req.url === '/latest/dynamic/instance-identity/document') {
            res.end(JSON.stringify({ accountId: host.accountId, region: host.region,
                instanceId: fault === 'identity' ? 'i-1123456789abcdef0' : host.scope.providerInstanceId })); return;
        }
        if (req.url === '/latest/meta-data/iam/security-credentials/') { res.end(fault === 'role' ? 'bad/../../role' : 'ComputerRole'); return; }
        res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: 'private-aws-key',
            Token: 'private-aws-session', Expiration: new Date(Date.now() + (fault === 'expired' ? -1 : 3600000)).toISOString() }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
    const send: MetadataRequest = (options, callback) => {
        assert.equal(options.hostname, '169.254.169.254'); assert.equal(options.port, 80);
        assert.ok(options.agent); assert.ok(options.signal);
        // This is the test-only TCP redirection. Production has no endpoint option.
        return request({ ...options, hostname: '127.0.0.1', port }, callback);
    };
    return { send, paths };
}
const expected = (host: Provisioning) => ({ accountId: host.accountId, region: host.region, instanceId: host.scope.providerInstanceId });

test('strict scoped reference matches the control-plane contract and canonical host parser', () => {
    const { host, bytes, delivery } = record();
    assert.deepEqual(validateDelivery(delivery, host), { value: delivery, host });
    assert.equal(validateConfiguration(bytes, delivery, host).configurationRevision, 7);
    for (const change of [ { ...delivery, scope: { ...delivery.scope, fenceToken: randomUUID() } },
        { ...delivery, object: { ...delivery.object, key: '../../other' } },
        { ...delivery, object: { ...delivery.object, versionId: 'null' } },
        { ...delivery, object: { ...delivery.object, sha256: '0'.repeat(64) } },
        { ...delivery, command: 'arbitrary-shell' }, { ...delivery, operation: 'start' } ]) {
        assert.throws(() => validateDelivery(change, host), /^Error: configuration_delivery_invalid$/);
    }
    for (const change of [{ ...host, accountId: '999999999999' }, { ...host, region: 'us-west-2' }, { ...host, key: 'secret' }]) {
        assert.throws(() => validateDelivery(delivery, change), /^Error: configuration_delivery_invalid$/);
    }
    for (const changed of [Buffer.from('private-invalid-content'), Buffer.concat([bytes, Buffer.from('\n')])]) {
        assert.throws(() => validateConfiguration(changed, delivery, host), /^Error: configuration_content_invalid$/);
    }
    const changed = JSON.parse(bytes.toString()); changed.controlPort = 12345;
    const changedBytes = Buffer.from(canonicalJson(changed)), digest = createHash('sha256').update(changedBytes).digest('hex');
    assert.throws(() => validateConfiguration(changedBytes, { ...delivery, digest, object: { ...delivery.object, bytes: changedBytes.length } }, host), /configuration_content_invalid/);
});

test('host identity requires IMDSv2 and returns only valid temporary credentials', async t => {
    const { host } = record(), mock = await metadata(t, host);
    const value = await instanceCredentials(expected(host), new AbortController().signal, mock.send);
    assert.equal(value.accessKeyId, 'ASIAABCDEFGHIJKLMNOP'); assert.equal(mock.paths.length, 4);
});
for (const fault of ['redirect', 'oversized', 'identity', 'role', 'expired']) test(`metadata ${fault} fails without fallback or sensitive errors`, async t => {
    const { host } = record(), mock = await metadata(t, host, fault);
    await assert.rejects(instanceCredentials(expected(host), new AbortController().signal, mock.send), /^Error: host_identity_unavailable$/);
    assert.ok(mock.paths.length <= 4);
});
test('metadata cancellation closes a hung request', async t => {
    const { host } = record(), mock = await metadata(t, host, 'hang');
    const controller = new AbortController();
    const pending = instanceCredentials(expected(host), controller.signal, mock.send);
    const assertion = assert.rejects(pending, /^Error: host_identity_unavailable$/);
    controller.abort(); await assertion;
});

for (const fault of ['', 'version', 'kms', 'size', 'bytes', 'registry']) test(`SDK fetch verifies exact version/checksum and scoped registry credentials: ${fault || 'valid'}`, async t => {
    const { host, delivery, bytes } = record(), mock = await metadata(t, host);
    const calls: { hostname: string; headers: Record<string, string>; query?: Record<string, unknown> }[] = [];
    const handler = { handle: async (req: { hostname: string; headers: Record<string, string>; query?: Record<string, unknown>; body?: unknown }) => {
        calls.push(req); assert.match(req.headers.authorization!, /^AWS4-HMAC-SHA256 /);
        if (req.hostname === 's3.us-east-1.amazonaws.com') {
            assert.equal(req.query?.versionId, 'version-1'); assert.equal(req.headers['x-amz-expected-bucket-owner'], host.accountId);
            return { response: { statusCode: 200, headers: { 'content-type': 'application/json',
                'content-length': String(fault === 'size' ? 9999999 : bytes.length),
                'x-amz-version-id': fault === 'version' ? 'different' : 'version-1',
                'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': fault === 'kms' ? 'unapproved' : host.kmsKeyArn,
                'x-amz-checksum-sha256': Buffer.from(delivery.digest, 'hex').toString('base64') },
                body: Readable.from([fault === 'bytes' ? Buffer.alloc(bytes.length) : bytes]) } };
        }
        assert.equal(req.hostname, 'api.ecr.us-east-1.amazonaws.com');
        const body = typeof req.body === 'string' ? req.body : Buffer.from(new Uint8Array(req.body as Uint8Array)).toString();
        assert.deepEqual(JSON.parse(body), { registryIds: [host.accountId] });
        return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.1' }, body: Readable.from([JSON.stringify({
            authorizationData: [{ proxyEndpoint: fault === 'registry' ? 'https://evil.invalid' : `https://${host.accountId}.dkr.ecr.us-east-1.amazonaws.com`,
                authorizationToken: Buffer.from('AWS:private-registry-password').toString('base64'), expiresAt: Date.now() / 1000 + 43200 }],
        })]) } };
    } };
    if (fault && fault !== 'registry') {
        await assert.rejects(fetchConfiguration(delivery, host, new AbortController().signal, { metadataRequest: mock.send, requestHandler: handler }),
            /^Error: configuration_download_unavailable$/); return;
    }
    const result = await fetchConfiguration(delivery, host, new AbortController().signal, { metadataRequest: mock.send, requestHandler: handler });
    t.after(result.destroy); assert.deepEqual(result.bytes, bytes);
    if (fault === 'registry') await assert.rejects(result.registryCredentials(), /registry_credentials_invalid/);
    else assert.deepEqual(JSON.parse((await result.registryCredentials()).toString()), [{ registry: `${host.accountId}.dkr.ecr.us-east-1.amazonaws.com`, token: 'private-registry-password' }]);
    assert.equal(calls.length, 2);
});
