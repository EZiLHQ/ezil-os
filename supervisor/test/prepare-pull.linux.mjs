import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { writeFile, readFile } from 'node:fs/promises';
import { prepareHostConfiguration } from '../dist/prepare.js';
import { Docker, DockerError } from '../dist/docker.js';

export async function verifyPreparationPull(root, baseConfig) {
    const artifact = JSON.parse(Buffer.from(process.env.EZIL_TEST_REGISTRY_CONFIG ?? '', 'base64').toString());
    const config = Buffer.from(artifact.config, 'base64');
    const layers = artifact.layers.map(encoded => Buffer.from(encoded, 'base64'));
    const parsed = JSON.parse(config.toString());
    assert.equal(parsed.architecture, 'amd64'); assert.equal(parsed.os, 'linux');
    const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const imageId = hash(config);
    const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
        config: { mediaType: 'application/vnd.docker.container.image.v1+json', size: config.length, digest: imageId },
        layers: layers.map(bytes => ({ mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip', size: bytes.length, digest: hash(bytes) })) }));
    const manifestDigest = hash(manifest);
    let requests = 0, credentialsLeaked = false;
    const server = createServer((req, res) => {
        requests++;
        credentialsLeaked ||= Boolean(req.headers.authorization);
        res.setHeader('Docker-Distribution-Api-Version', 'registry/2.0');
        if (req.url === '/v2/') return res.end('{}');
        let bytes, type, digest;
        if (req.url === `/v2/prepared/manifests/${manifestDigest}`) {
            bytes = manifest; type = 'application/vnd.docker.distribution.manifest.v2+json'; digest = manifestDigest;
        } else if (req.url === `/v2/prepared/blobs/${imageId}`) {
            bytes = config; type = 'application/octet-stream'; digest = imageId;
        } else if (layers.some(layer => req.url === `/v2/prepared/blobs/${hash(layer)}`)) {
            bytes = layers.find(layer => req.url === `/v2/prepared/blobs/${hash(layer)}`);
            type = 'application/octet-stream'; digest = hash(bytes);
        } else { res.writeHead(404); return res.end('{}'); }
        res.writeHead(200, { 'content-type': type, 'content-length': bytes.length, 'Docker-Content-Digest': digest });
        res.end(req.method === 'HEAD' ? undefined : bytes);
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const reference = `127.0.0.1:${server.address().port}/prepared@${manifestDigest}`;
    const desired = structuredClone(baseConfig);
    desired.approvedInstallations = [{ installationId: randomUUID(), plan: {
        ...desired.approvedInstallations[0].plan, image: reference,
    } }];
    const input = `${root}/config/pull-desired.json`, active = `${root}/config/pull-active.json`;
    const docker = new Docker();
    try {
        await assert.rejects(docker.call('GET', `/images/${encodeURIComponent(reference)}/json`),
            error => error instanceof DockerError && error.status === 404);
        await writeFile(input, JSON.stringify(desired), { mode: 0o600 });
        const receipt = await prepareHostConfiguration(input, active, { privateValidation: true });
        assert.deepEqual(receipt.preparedImages, [{ reference, contentId: imageId }]);
        assert.ok(requests > 0); assert.equal(credentialsLeaked, false);
        const before = requests;
        await prepareHostConfiguration(input, active, { privateValidation: true });
        assert.equal(requests, before, 'already verified local digest is not pulled on retry');
        assert.equal(JSON.parse(await readFile(active, 'utf8')).approvedInstallations[0].plan.image, reference);
        const filters = encodeURIComponent(JSON.stringify({ ancestor: [imageId] }));
        assert.equal((await docker.call('GET', `/containers/json?all=true&filters=${filters}`)).length, 0);
        console.log('PASS: actual Docker digest pull from a local registry, exact image verification, retry without pull, no app execution');
    } finally {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        try { await docker.call('DELETE', `/images/${encodeURIComponent(reference)}?force=true`); }
        catch (error) { if (!(error instanceof DockerError && error.status === 404)) throw error; }
    }
}
