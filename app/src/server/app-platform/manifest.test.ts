import { describe, expect, it } from 'vitest';

import {
    PILOT_LIMITS,
    checkPilotCompatibility,
    getManifestDigest,
    validateAppManifest,
} from './manifest';

const ID = 'a1111111-1111-4111-8111-111111111111';
const PUBLISHER = 'b2222222-2222-4222-8222-222222222222';
const SECRET = 'c3333333-3333-4333-8333-333333333333';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function hosted(over: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1, appId: ID, publisherId: PUBLISHER, name: 'Demo', slug: 'demo', version: '1.0.0',
        source: { kind: 'hosted', url: 'https://demo.example.com' },
        launch: { mode: 'web', path: '/', embedding: { mode: 'external' } },
        runtime: { profile: 'external' }, capabilities: [], secrets: [], egressOrigins: [],
        persistence: { mode: 'publisher-managed' }, ...over,
    };
}

function node(over: Record<string, unknown> = {}) {
    return {
        ...hosted(),
        source: { kind: 'github', url: 'https://github.com/acme/demo', commitSha: 'b'.repeat(40) },
        runtime: { profile: 'node24-http-v1', entrypoint: 'dist/server.mjs', port: 8080, health: { path: '/health', status: 200 } },
        build: { recipe: 'npm-ci-v1', script: 'build' }, resources: { cpu: .25, memoryMiB: 1024, diskMiB: 4096, maxRuntimeSeconds: 3600 },
        persistence: { mode: 'ephemeral' }, ...over,
    };
}

function parse(input: unknown) { return validateAppManifest(input); }
function issue(input: unknown) {
    const result = parse(input);
    expect(result.success).toBe(false);
    return result.success ? [] : result.issues;
}

describe('AppManifestV1Schema', () => {
    it('accepts hosted manifests and applies defaults and UUID normalization', () => {
        const result = parse(hosted({ appId: ID.toUpperCase(), capabilities: undefined, secrets: undefined, egressOrigins: undefined }));
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.appId).toBe(ID);
            expect(result.data).toMatchObject({ capabilities: [], secrets: [], egressOrigins: [] });
        }
    });

    it('accepts a Node GitHub manifest with normalized source and defaults', () => {
        const result = parse(node({ source: { kind: 'github', url: 'https://GitHub.com/acme/demo/', commitSha: 'C'.repeat(40) } }));
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.source).toMatchObject({ url: 'https://github.com/acme/demo', commitSha: 'c'.repeat(40) });
    });

    it('recognizes pinned OCI but marks it incompatible with the pilot', () => {
        const result = parse(hosted({ source: { kind: 'oci', image: `registry.example.com/acme/demo@${DIGEST}` }, runtime: { profile: 'oci-linux-amd64', port: 8080, health: { path: '/', status: 204 } }, resources: { cpu: .25, memoryMiB: 1024, diskMiB: 4096, maxRuntimeSeconds: 30 }, persistence: { mode: 'ephemeral' } }));
        expect(result.success).toBe(true);
        if (result.success) expect(checkPilotCompatibility(result.data)).toMatchObject({
            success: false, issues: [{ path: ['source', 'kind'], code: 'unsupported_source' }],
        });
    });

    it.each([
        ['bad digest', { kind: 'oci', image: 'registry.example.com/a@sha256:abc' }],
        ['mutable tag', { kind: 'oci', image: 'registry.example.com/a:latest' }],
        ['missing pin', { kind: 'oci', image: 'registry.example.com/a' }],
        ['tag and digest', { kind: 'oci', image: `registry.example.com/a:latest@${DIGEST}` }],
        ['local registry', { kind: 'oci', image: `127.0.0.1/a@${DIGEST}` }],
    ])('rejects %s', (_label, source) => expect(issue(hosted({ source, runtime: { profile: 'oci-linux-amd64', port: 8080, health: { path: '/', status: 200 } }, resources: { cpu: .25, memoryMiB: 1024, diskMiB: 4096, maxRuntimeSeconds: 30 }, persistence: { mode: 'ephemeral' } }))).not.toHaveLength(0));

    it.each(['node20-http-v1', 'oci-linux-arm64', 'future-profile'])('rejects unknown runtime profile %s', profile => {
        expect(issue(node({ runtime: { profile, entrypoint: 'dist/server.mjs', port: 8080, health: { path: '/', status: 200 } } }))).not.toHaveLength(0);
    });

    it.each([
        ['missing commit', undefined], ['short commit', 'a'.repeat(39)], ['branch name', 'main'],
    ])('rejects GitHub %s', (_label, commitSha) => {
        const source = commitSha === undefined
            ? { kind: 'github', url: 'https://github.com/acme/demo' }
            : { kind: 'github', url: 'https://github.com/acme/demo', commitSha };
        expect(issue(node({ source }))).not.toHaveLength(0);
    });

    it.each(['https://github.com/acme/demo/tree/main', 'https://github.com.evil.com/acme/demo', 'https://github.com/acme/../acme/demo'])('rejects GitHub source lookalike or tree URL %s', url => {
        expect(issue(node({ source: { kind: 'github', url, commitSha: 'a'.repeat(40) } }))).not.toHaveLength(0);
    });

    it.each([
        ['userinfo', 'https://u:p@example.com'], ['decimal IP', 'https://2130706433'], ['hex IP', 'https://0x7f000001'],
        ['IPv6', 'https://[::1]'], ['IPv4', 'https://127.0.0.1'], ['metadata IP', 'https://169.254.169.254'],
        ['octal IP', 'https://0177.0.0.1'], ['private IP', 'https://10.0.0.1'],
        ['localhost', 'https://localhost'], ['encoded host', 'https://example%2ecom'],
        ['port', 'https://example.com:8443'], ['query', 'https://example.com/?x=1'], ['local', 'https://service.internal'],
        ['backslash', 'https://example.com\\evil'], ['wrong scheme', 'http://example.com'],
        ['script scheme', 'javascript:alert(1)'], ['file scheme', 'file:///etc/passwd'],
        ['empty userinfo', 'https://@example.com'], ['embedded path', 'https://example.com/app'],
    ])('rejects unsafe origin: %s', (_label, url) => expect(issue(hosted({ source: { kind: 'hosted', url } }))).not.toHaveLength(0));

    it.each(['../server.mjs', 'dist/../server.mjs', '/tmp/server.js', 'server\u001b.js', 'dist\\server.js', '%2e%2e/server.js'])('rejects escaped or traversing entrypoint %s', entrypoint => {
        expect(issue(node({ runtime: { profile: 'node24-http-v1', entrypoint, port: 8080, health: { path: '/', status: 200 } } }))).not.toHaveLength(0);
    });

    it.each(['server.ts', '--inspect.js', ''])('rejects non-JS or flag-like entrypoint %s', entrypoint => {
        expect(issue(node({ runtime: { profile: 'node24-http-v1', entrypoint, port: 8080, health: { path: '/', status: 200 } } }))).not.toHaveLength(0);
    });

    it.each([
        ['launch absolute URL', { path: 'https://other.example.com/app', embedding: { mode: 'external' } }],
        ['launch authority', { path: '//other.example.com/app', embedding: { mode: 'external' } }],
        ['launch traversal', { path: '/../app', embedding: { mode: 'external' } }],
        ['health traversal', { path: '/%2e%2e/health', status: 200 }],
    ])('rejects %s paths', (_label, value) => {
        const manifest = _label === 'health traversal'
            ? node({ runtime: { profile: 'node24-http-v1', entrypoint: 'dist/server.mjs', port: 8080, health: value } })
            : hosted({ launch: { mode: 'web', ...value } });
        expect(issue(manifest)).not.toHaveLength(0);
    });

    it('rejects absolute or traversing Git subdirectories', () => {
        for (const subdirectory of ['/src', '../src', 'src/../app', 'src/%2e%2e/app', 'src\\app']) {
            expect(issue(node({ source: { kind: 'github', url: 'https://github.com/acme/demo', commitSha: 'a'.repeat(40), subdirectory } }))).not.toHaveLength(0);
        }
    });

    it.each([1023, 65536, 8080.5])('rejects invalid port %s', port => {
        expect(issue(node({ runtime: { profile: 'node24-http-v1', entrypoint: 'dist/server.mjs', port, health: { path: '/', status: 200 } } }))).not.toHaveLength(0);
    });

    it('rejects hosted runtime resources and secrets misuse', () => {
        expect(issue(hosted({ resources: { cpu: .25, memoryMiB: 1024, diskMiB: 4096, maxRuntimeSeconds: 30 } }))).toContainEqual({ path: ['resources'], code: 'custom' });
        expect(issue(hosted({ secrets: [{ name: 'TOKEN', ref: SECRET }] }))).toContainEqual({ path: ['secrets'], code: 'custom' });
    });

    it.each(['AWS_SECRET', 'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NPM_CONFIG_USERCONFIG', 'PATH', 'PORT', 'BAD-NAME'])('rejects reserved or invalid secret name %s', name => {
        expect(issue(node({ secrets: [{ name, ref: SECRET }] }))).not.toHaveLength(0);
    });

    it('rejects duplicate secret names, invalid refs, and sentinel secret values', () => {
        expect(issue(node({ secrets: [{ name: 'TOKEN', ref: SECRET }, { name: 'TOKEN', ref: ID }] }))).not.toHaveLength(0);
        expect(issue(node({ secrets: [{ name: 'TOKEN', ref: 'not-a-uuid' }] }))).not.toHaveLength(0);
        const errors = issue(node({ secrets: [{ name: 'TOKEN', ref: SECRET, value: 'SECRET_SENTINEL' }] }));
        expect(JSON.stringify(errors)).not.toContain('SECRET_SENTINEL');
    });

    it('requires coherent object persistence capability and external DB reference', () => {
        expect(issue(node({ persistence: { mode: 'objects', maxBytes: 10 } }))).toContainEqual({ path: ['capabilities'], code: 'custom' });
        expect(issue(node({ persistence: { mode: 'external-database', secretRef: SECRET } }))).toContainEqual({ path: ['persistence', 'secretRef'], code: 'custom' });
        expect(parse(node({ persistence: { mode: 'external-database', secretRef: SECRET }, secrets: [{ name: 'DATABASE_URL', ref: SECRET }] })).success).toBe(true);
    });

    it.each([
        ['cpu', { cpu: PILOT_LIMITS.cpu + .01 }], ['memory', { memoryMiB: 2048 }], ['disk', { diskMiB: 8192 }], ['runtime', { maxRuntimeSeconds: 28_801 }],
    ])('reports unsupported %s requirement', (_label, change) => {
        const result = parse(node({ resources: { cpu: .25, memoryMiB: 1024, diskMiB: 4096, maxRuntimeSeconds: 3600, ...change } }));
        expect(result.success).toBe(true);
        if (result.success) expect(checkPilotCompatibility(result.data).success).toBe(false);
    });

    it('rejects unsupported service launch, AI, and oversized storage', () => {
        const cases = [
            node({ launch: { mode: 'service' } }), node({ capabilities: ['ai.responses'] }),
            node({ persistence: { mode: 'objects', maxBytes: PILOT_LIMITS.objectBytes + 1 }, capabilities: ['storage.objects'] }),
        ];
        for (const value of cases) { const result = parse(value); expect(result.success).toBe(true); if (result.success) expect(checkPilotCompatibility(result.data).success).toBe(false); }
    });

    it('accepts actual hosted and Node pilot-compatible manifests', () => {
        const hostedResult = parse(hosted());
        const nodeResult = parse(node());
        expect(hostedResult.success && nodeResult.success).toBe(true);
        if (hostedResult.success) expect(checkPilotCompatibility(hostedResult.data)).toEqual({ success: true, data: 'hosted' });
        if (nodeResult.success) expect(checkPilotCompatibility(nodeResult.data)).toEqual({ success: true, data: 'node-http' });
    });

    it('rejects capabilities in an opaque iframe', () => {
        const result = parse(hosted({ capabilities: ['context.read'], launch: { mode: 'web', path: '/', embedding: { mode: 'iframe', sandbox: ['allow-scripts'] } } }));
        expect(result.success).toBe(true);
        if (result.success) expect(checkPilotCompatibility(result.data)).toMatchObject({
            success: false, issues: [{ path: ['launch', 'embedding', 'sandbox'], code: 'opaque_origin_capabilities' }],
        });
    });

    it('accepts a declared external database as a Node candidate for later deployment gates', () => {
        const result = parse(node({
            persistence: { mode: 'external-database', secretRef: SECRET },
            secrets: [{ name: 'DATABASE_URL', ref: SECRET }],
        }));
        expect(result.success).toBe(true);
        if (result.success) expect(checkPilotCompatibility(result.data)).toEqual({ success: true, data: 'node-http' });
    });

    it('rejects iframe embedding without an explicit sandbox permission list', () => {
        expect(issue(hosted({ launch: { mode: 'web', path: '/', embedding: { mode: 'iframe' } } }))).not.toHaveLength(0);
    });

    it('returns safe issues without sentinel secret values or unknown property names', () => {
        const sentinel = 'SECRET_SENTINEL_SHOULD_NOT_APPEAR';
        const result = issue(hosted({ [sentinel]: sentinel, name: sentinel, secrets: [{ name: 'BAD-NAME', ref: ID }] }));
        expect(JSON.stringify(result)).not.toContain(sentinel);
        expect(JSON.stringify(result)).not.toContain('unknown');
    });

    it.each([
        ['schema version', hosted({ schemaVersion: 2 })],
        ['top-level property', hosted({ mystery: true })],
        ['nested property', hosted({ launch: { mode: 'web', path: '/', embedding: { mode: 'external', mystery: true } } })],
        ['unknown capability', hosted({ capabilities: ['future.capability'] })],
        ['duplicate capability', hosted({ capabilities: ['context.read', 'context.read'] })],
        ['blank name', hosted({ name: '   ' })],
        ['deployment command', node({ build: { recipe: 'npm-ci-v1', script: 'build && deploy' } })],
    ])('rejects %s', (_label, value) => expect(issue(value)).not.toHaveLength(0));

    it('canonical digest is independent of object key insertion order', () => {
        const a = parse(node());
        const b = parse({ persistence: { mode: 'ephemeral' }, egressOrigins: [], secrets: [], capabilities: [], runtime: node().runtime, launch: node().launch, source: node().source, version: '1.0.0', slug: 'demo', name: 'Demo', publisherId: PUBLISHER, appId: ID, schemaVersion: 1, build: node().build, resources: node().resources });
        expect(a.success && b.success).toBe(true);
        if (a.success && b.success) expect(getManifestDigest(a.data)).toBe(getManifestDigest(b.data));
    });

    it('accepts canonical HTTP paths, source subdirectories and optional Git suffixes', () => {
        const result = parse(node({
            source: { kind: 'github', url: 'https://GitHub.com/acme/demo.git/', commitSha: 'a'.repeat(40), subdirectory: 'packages/web' },
            launch: { mode: 'web', path: '/tmp/app/', embedding: { mode: 'external' } },
            secrets: [{ name: 'TOKEN', ref: SECRET }],
        }));
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.source).toMatchObject({ url: 'https://github.com/acme/demo' });
    });

    it('digest binds source, identity, and argv', () => {
        const base = parse(node());
        expect(base.success).toBe(true);
        if (!base.success) return;
        for (const change of [
            { source: { kind: 'github', url: 'https://github.com/acme/other', commitSha: 'b'.repeat(40) } },
            { publisherId: ID }, { runtime: { ...base.data.runtime, args: ['--different'] } },
        ]) {
            const changed = parse({ ...base.data, ...change });
            expect(changed.success).toBe(true);
            if (changed.success) expect(getManifestDigest(changed.data)).not.toBe(getManifestDigest(base.data));
        }
    });
});
