import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, readdir, rename, symlink, unlink } from 'node:fs/promises';
import { canonicalJson } from '../dist/control-protocol.js';
import { parseHostConfig } from '../dist/host-config.js';
import { receiveConfiguration } from '../dist/configuration-receiver.js';
import { acquireHostLock } from '../dist/host-lock.js';
import { Docker } from '../dist/docker.js';

/** Actual root filesystem, Docker preparation and running Node supervisor.
 * IMDS/S3 are local fixtures; reload sends a real signal to the test process.
 * This does not test SSM dispatch, systemd or AWS networking/identity. */
export async function verifyConfigurationReceiver({ root, config, revision, process, observe, until, owned }) {
    const provisioningPath = `${root}/config/provisioning.json`, activePath = `${root}/config/config.json`;
    const host = { schemaVersion: 1, accountId: '123456789012', region: 'us-east-1', namespace: 'pilot', bucket: 'ezil-pilot-config',
        kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc', scope: {
            computerId: config.computerId, computerGeneration: config.computerGeneration, dataVolumeId: config.volumeId,
            providerInstanceId: 'i-0123456789abcdef0', fenceToken: randomUUID() } };
    const provisioned = JSON.stringify(host);
    await writeFile(provisioningPath, provisioned, { mode: 0o600 });
    let bytes = Buffer.from(canonicalJson(parseHostConfig({ ...config, configurationRevision: revision + 1 }, true)));
    const value = () => {
        const configurationId = randomUUID(), digest = createHash('sha256').update(bytes).digest('hex');
        return { schemaVersion: 1, operation: 'prepare', configurationId, scope: host.scope, revision: JSON.parse(bytes).configurationRevision, digest,
            object: { bucket: host.bucket, key: `pilot/computers/${config.computerId}/generations/1/configurations/${configurationId}.json`,
                versionId: 'version-1', sha256: digest, bytes: bytes.length } };
    };
    let desired = value(), corrupt = false, reloads = 0, awsCalls = 0;
    const server = createServer((req, res) => {
        if (req.url === '/latest/api/token') return res.end('local-imds-token');
        assert.equal(req.headers['x-aws-ec2-metadata-token'], 'local-imds-token');
        if (req.url === '/latest/dynamic/instance-identity/document') return res.end(JSON.stringify({
            accountId: host.accountId, region: host.region, instanceId: host.scope.providerInstanceId }));
        if (req.url === '/latest/meta-data/iam/security-credentials/') return res.end('ComputerRole');
        return res.end(JSON.stringify({ Code: 'Success', AccessKeyId: 'ASIAABCDEFGHIJKLMNOP', SecretAccessKey: 'local-key',
            Token: 'local-session', Expiration: new Date(Date.now() + 3600000).toISOString() }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const options = { privateValidation: true, provisioningPath, activePath,
        metadataRequest: (input, callback) => request({ ...input, hostname: '127.0.0.1', port: server.address().port }, callback),
        reload: async () => { reloads++; assert(process.kill('SIGHUP')); },
        requestHandler: { handle: async req => {
            awsCalls++; assert.equal(req.hostname, 's3.us-east-1.amazonaws.com'); assert.equal(req.method, 'GET');
            assert.equal(req.query.versionId, 'version-1');
            return { response: { statusCode: 200, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length),
                'x-amz-version-id': 'version-1', 'x-amz-server-side-encryption': 'aws:kms',
                'x-amz-server-side-encryption-aws-kms-key-id': host.kmsKeyArn,
                'x-amz-checksum-sha256': Buffer.from(desired.digest, 'hex').toString('base64') },
                body: Readable.from([corrupt ? Buffer.alloc(bytes.length) : bytes]) } };
        } } };
    try {
        const beforeContainers = await owned();
        const prepared = await receiveConfiguration(desired, options);
        assert.equal(prepared.descriptor.configurationDigest, desired.digest);
        assert.equal((await observe()).configurationRevision, revision, 'prepared bytes are not a loaded receipt');
        assert.equal(reloads, 0); assert.equal((await owned()).length, beforeContainers.length, 'delivery does not create apps');
        await receiveConfiguration({ ...desired, operation: 'reload' }, options);
        await until(async () => (await observe()).configurationRevision === revision + 1);
        assert.equal(reloads, 1); assert.equal(awsCalls, 1, 'reload does not download or pull');
        const active = await readFile(activePath);
        await assert.rejects(receiveConfiguration({ ...desired, scope: { ...host.scope, fenceToken: randomUUID() } }, options), /configuration_delivery_invalid/);
        corrupt = true; await assert.rejects(receiveConfiguration(desired, options), /configuration_delivery_unavailable/); corrupt = false;
        const signal = new AbortController(); signal.abort();
        await assert.rejects(receiveConfiguration(desired, { ...options, signal: signal.signal }), /configuration_delivery_cancelled/);
        const lock = await acquireHostLock('delivery');
        try { await assert.rejects(receiveConfiguration(desired, options), /delivery_already_running/); }
        finally { await lock.release(); }
        bytes = Buffer.from(canonicalJson(parseHostConfig({ ...config, configurationRevision: revision + 2 }, true))); desired = value();
        await assert.rejects(receiveConfiguration({ ...desired, operation: 'reload' }, options), /configuration_content_invalid/);
        assert.equal(reloads, 1);
        await rename(`${root}/disk/.ezil-volume.json`, `${root}/disk/receiver-marker`);
        try { await assert.rejects(receiveConfiguration(desired, options), /configuration_delivery_unavailable/); }
        finally { await rename(`${root}/disk/receiver-marker`, `${root}/disk/.ezil-volume.json`); }
        // Change trusted provisioning while an actual Docker inspection is in
        // flight. The pre-commit fence must leave the original file untouched.
        const original = Docker.prototype.call;
        Docker.prototype.call = async function (...args) {
            const result = await original.apply(this, args);
            if (String(args[1]).startsWith('/images/')) await writeFile(provisioningPath, JSON.stringify({ ...host, scope: { ...host.scope, fenceToken: randomUUID() } }), { mode: 0o600 });
            return result;
        };
        try { await assert.rejects(receiveConfiguration(desired, options), /configuration_delivery_fenced/); }
        finally { Docker.prototype.call = original; await writeFile(provisioningPath, provisioned, { mode: 0o600 }); }
        assert.deepEqual(await readFile(activePath), active);
        assert.deepEqual((await readdir('/run/ezil-supervisor')).filter(name => name.startsWith('delivery-')), []);
        await rename(provisioningPath, `${provisioningPath}.held`); await symlink(activePath, provisioningPath);
        try { await assert.rejects(receiveConfiguration(desired, options), /configuration_delivery_unavailable/); }
        finally { await unlink(provisioningPath); await rename(`${provisioningPath}.held`, provisioningPath); }
        assert.equal((await observe()).configurationRevision, revision + 1);
        console.log('configuration receiver: prepare/reload, writer fence, corruption, cancellation, mount failure, locks and cleanup passed');
        return revision + 1;
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
