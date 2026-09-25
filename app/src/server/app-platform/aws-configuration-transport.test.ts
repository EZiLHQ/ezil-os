import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalConfiguration } from './computer-configuration';
import { createAwsConfigurationTransport, type AwsConfigurationTransportOptions } from './aws-configuration-transport';
import type { ConfigurationWork } from './configuration-delivery';

const settings = { region: 'us-east-1' as const, accountId: '123456789012', namespace: 'pilot', bucket: 'ezil-config-test',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc',
    stateMachineVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:configuration:7', controlDomain: 'control.ezil.org' };
const credentials = async () => ({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'test-only-secret',
    sessionToken: 'test-only-session', expiration: new Date(Date.now() + 3600000) });
function work(): ConfigurationWork {
    const scope = { computerId: randomUUID(), computerGeneration: 2, providerInstanceId: 'i-0123456789abcdef0',
        dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() };
    const configuration = canonicalConfiguration({ schemaVersion: 1, computerId: scope.computerId,
        computerGeneration: scope.computerGeneration, configurationRevision: 4, volumeId: scope.dataVolumeId,
        privateConfigurationMarker: 'must-never-enter-workflow-history' });
    return { configurationId: randomUUID(), scope, revision: 4, configuration,
        digest: createHash('sha256').update(configuration).digest('hex') };
}
type WireRequest = { hostname: string; protocol: string; method: string; path: string; headers: Record<string, string>; body?: unknown };
type Execution = { executionArn: string; name: string; stateMachineArn: string; stateMachineVersionArn: string;
    input: string; startDate: number; status: string; redriveCount: number; output?: string; stateMachineAliasArn?: string };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Real SDK serialization, SigV4, XML/JSON decoding and streaming, with a
 * local wire handler. This is not an AWS/IAM/EBS acceptance test. */
function fixture() {
    const calls: (WireRequest & { text: string })[] = [];
    const objects = new Map<string, { bytes: Buffer; headers: Record<string, string> }>();
    const executions = new Map<string, Execution>();
    let losePut = false, loseStart = false, machineType = 'STANDARD', secret: Record<string, unknown> = {};
    let block = '';
    const response = (statusCode: number, body: string | Buffer, headers: Record<string, string> = {}) =>
        ({ response: { statusCode, headers, body: Readable.from([body]) } });
    const json = (body: unknown, status = 200) => response(status, JSON.stringify(body), { 'content-type': 'application/x-amz-json-1.0' });
    const missing = (name: string) => json({ __type: name, message: 'sensitive-provider-details' }, 400);
    const handler = { handle: async (request: WireRequest) => {
        const text = request.body === undefined ? '' : typeof request.body === 'string' ? request.body
            : Buffer.from(new Uint8Array(request.body as Uint8Array)).toString();
        calls.push({ ...request, text });
        const action = request.headers['x-amz-target']?.split('.').at(-1) ?? request.method;
        if (block === action) return new Promise<never>(() => {});
        if (request.hostname === 's3.us-east-1.amazonaws.com') {
            if (request.method === 'PUT') {
                if (objects.has(request.path)) return response(412, '<Error><Code>PreconditionFailed</Code></Error>', { 'content-type': 'application/xml' });
                const bytes = Buffer.from(request.body as Uint8Array);
                objects.set(request.path, { bytes, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length),
                    'x-amz-version-id': 'immutable-version-1', 'x-amz-server-side-encryption': 'aws:kms',
                    'x-amz-server-side-encryption-aws-kms-key-id': settings.kmsKeyArn,
                    'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64'), 'last-modified': new Date().toUTCString() } });
                if (losePut) { losePut = false; throw new Error('sensitive-lost-put-response'); }
                return response(200, '', { 'x-amz-version-id': 'immutable-version-1' });
            }
            const object = objects.get(request.path);
            return object ? response(200, object.bytes, object.headers)
                : response(404, '<Error><Code>NoSuchKey</Code></Error>', { 'content-type': 'application/xml' });
        }
        const input = JSON.parse(text);
        if (action === 'DescribeStateMachine') return json({ stateMachineArn: input.stateMachineArn, type: machineType, status: 'ACTIVE' });
        if (action === 'DescribeExecution') return executions.has(input.executionArn) ? json(executions.get(input.executionArn)) : missing('ExecutionDoesNotExist');
        if (action === 'StartExecution') {
            const executionArn = `arn:aws:states:us-east-1:123456789012:execution:configuration:${input.name}`;
            if (!executions.has(executionArn)) executions.set(executionArn, { executionArn, name: input.name, input: input.input,
                stateMachineArn: settings.stateMachineVersionArn.slice(0, -2), stateMachineVersionArn: settings.stateMachineVersionArn,
                startDate: Date.now() / 1000, status: 'RUNNING', redriveCount: 0 });
            if (loseStart) { loseStart = false; throw new Error('sensitive-lost-start-response'); }
            return json({ executionArn, startDate: Date.now() / 1000 });
        }
        if (action === 'GetSecretValue') return json(secret);
        throw new Error('unexpected_aws_operation');
    } };
    const options: AwsConfigurationTransportOptions = { settings, credentials, requestHandler: handler };
    const transport = createAwsConfigurationTransport(options); cleanup.push(transport.destroy);
    const advance = (value: ConfigurationWork) => transport.advancePreparation(value, new AbortController().signal);
    const loaded = (value: ConfigurationWork, operation = 'prepare') => {
        const execution = [...executions.values()].find(item => JSON.parse(item.input).operation === operation)!;
        execution.status = 'SUCCEEDED';
        execution.output = JSON.stringify({ schemaVersion: 1, operation, configurationId: value.configurationId, scope: value.scope,
            descriptor: { computerId: value.scope.computerId, computerGeneration: value.scope.computerGeneration,
                configurationRevision: value.revision, configurationDigest: value.digest } });
        return execution;
    };
    return { calls, objects, executions, options, transport, advance, loaded,
        losePut: () => { losePut = true; }, loseStart: () => { loseStart = true; }, express: () => { machineType = 'EXPRESS'; },
        block: (action: string) => { block = action; }, secret: (value: Record<string, unknown>) => { secret = value; } };
}

describe('AWS configuration delivery over the SDK wire', () => {
    it('stages an encrypted versioned object and sends only a scoped immutable reference', async () => {
        const f = fixture(), value = work();
        expect(await f.advance(value)).toEqual({ state: 'pending' });
        const put = f.calls.find(call => call.method === 'PUT')!;
        expect(put.path).toContain(`/computers/${value.scope.computerId}/generations/2/configurations/${value.configurationId}.json`);
        expect(put.text).toBe(value.configuration);
        expect(put.headers).toMatchObject({ 'if-none-match': '*', 'x-amz-expected-bucket-owner': settings.accountId,
            'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': settings.kmsKeyArn });
        for (const call of f.calls) {
            expect(call.protocol).toBe('https:');
            expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
        }
        const execution = [...f.executions.values()][0];
        expect(execution.input).not.toContain('must-never-enter-workflow-history');
        expect(execution.input).not.toContain('test-only-secret');
        expect(JSON.parse(execution.input)).toMatchObject({ scope: value.scope, object: { versionId: 'immutable-version-1', sha256: value.digest } });
        expect(await f.advance(value)).toEqual({ state: 'pending' });
        f.loaded(value);
        expect(await f.advance(value)).toMatchObject({ state: 'prepared', descriptor: { configurationDigest: value.digest } });
        expect(f.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
        expect(f.calls.filter(call => call.headers['x-amz-target']?.endsWith('StartExecution'))).toHaveLength(1);
        await f.transport.requestReload(value, new AbortController().signal);
        expect(f.executions.size).toBe(2);
        expect(JSON.parse([...f.executions.values()][1].input).operation).toBe('reload');
    });
    it('recovers concurrent claims and lost responses without new keys or execution names', async () => {
        const f = fixture(), value = work(); f.losePut(); f.loseStart();
        expect(await Promise.all([f.advance(value), f.advance(value)])).toEqual([{ state: 'pending' }, { state: 'pending' }]);
        expect(f.objects.size).toBe(1); expect(f.executions.size).toBe(1);
        expect(await f.advance(value)).toEqual({ state: 'pending' });
    });
    it('isolates computers and replacements in storage and execution scope', async () => {
        const f = fixture(), first = work(), second = work();
        await f.advance(first); await f.advance(second);
        expect(f.objects.size).toBe(2); expect(f.executions.size).toBe(2);
        await expect(f.advance({ ...first, scope: { ...first.scope, fenceToken: randomUUID() } })).rejects.toThrow('aws_configuration_conflict');
    });
    it.each(['digest', 'computer', 'revision', 'unknown', 'canonical', 'oversized'])('rejects invalid %s before any AWS request', async kind => {
        const f = fixture(), value = { ...work() };
        if (kind === 'digest') value.digest = '0'.repeat(64);
        if (kind === 'computer') value.scope.computerId = randomUUID();
        if (kind === 'revision') value.revision++;
        if (kind === 'unknown') Object.assign(value, { bucket: 'caller-chosen' });
        if (kind === 'canonical') value.configuration = ` ${value.configuration}`;
        if (kind === 'oversized') value.configuration = 'x'.repeat(262145);
        await expect(f.advance(value)).rejects.toThrow('aws_configuration_invalid'); expect(f.calls).toHaveLength(0);
    });
    it.each(['version', 'encryption', 'owner-key', 'bytes', 'length'])('rejects staged %s mismatches', async kind => {
        const f = fixture(), value = work(); await f.advance(value);
        const object = [...f.objects.values()][0];
        if (kind === 'version') object.headers['x-amz-version-id'] = 'null';
        if (kind === 'encryption') object.headers['x-amz-server-side-encryption'] = 'AES256';
        if (kind === 'owner-key') object.headers['x-amz-server-side-encryption-aws-kms-key-id'] = settings.kmsKeyArn.replace('123456789012', '999999999999');
        if (kind === 'bytes') object.bytes[0] = 0;
        if (kind === 'length') object.headers['content-length'] = '999999999';
        await expect(f.advance(value)).rejects.toThrow(/aws_configuration_(conflict|unavailable)/);
    });
    it.each(['FAILED', 'TIMED_OUT', 'ABORTED', 'PENDING_REDRIVE'])('does not restart %s executions', async status => {
        const f = fixture(), value = work(); await f.advance(value);
        [...f.executions.values()][0].status = status;
        await expect(f.advance(value)).rejects.toThrow('aws_workflow_failed'); expect(f.executions.size).toBe(1);
    });
    it.each(['input', 'version', 'redrive', 'output', 'alias'])('rejects changed execution %s', async kind => {
        const f = fixture(), value = work(); await f.advance(value); const execution = f.loaded(value);
        if (kind === 'input') execution.input += ' ';
        if (kind === 'version') execution.stateMachineVersionArn = settings.stateMachineVersionArn.replace(':7', ':8');
        if (kind === 'redrive') execution.redriveCount = 1;
        if (kind === 'output') execution.output = JSON.stringify({ descriptor: { configurationDigest: value.digest } });
        if (kind === 'alias') execution.stateMachineAliasArn = 'unapproved';
        await expect(f.advance(value)).rejects.toThrow('aws_configuration_conflict');
    });
    it('refuses Express and refuses to reuse expired Standard execution names', async () => {
        const f = fixture(), value = work(); f.express();
        await expect(f.advance(value)).rejects.toThrow('aws_configuration_conflict'); expect(f.executions.size).toBe(0);
        [...f.objects.values()][0].headers['last-modified'] = new Date(Date.now() - 91 * 86400000).toUTCString();
        await expect(f.advance(value)).rejects.toThrow('aws_configuration_expired'); expect(f.executions.size).toBe(0);
    });
    it('bounds a hung request and never sends workflow cancellation on caller abort', async () => {
        const f = fixture(), controller = new AbortController(); f.block('GET');
        const pending = f.transport.advancePreparation(work(), controller.signal);
        const assertion = expect(pending).rejects.toThrow('aws_configuration_unavailable');
        await vi.waitFor(() => expect(f.calls).toHaveLength(1)); controller.abort(); await assertion;
        expect(f.calls).toHaveLength(1);
    });
    it('times out even when the wire handler ignores its abort signal', async () => {
        const f = fixture(); f.block('GET'); vi.useFakeTimers();
        try {
            const pending = f.advance(work());
            const assertion = expect(pending).rejects.toThrow('aws_configuration_unavailable');
            await vi.advanceTimersByTimeAsync(8100); await assertion;
            expect(f.calls).toHaveLength(1);
        } finally { vi.useRealTimers(); }
    });
    it('supports the maximum configuration without putting it in the workflow envelope', async () => {
        const f = fixture(), value = { ...work() };
        const body = JSON.parse(value.configuration); body.padding = '';
        body.padding = 'x'.repeat(262144 - Buffer.byteLength(canonicalConfiguration(body)));
        value.configuration = canonicalConfiguration(body);
        value.digest = createHash('sha256').update(value.configuration).digest('hex');
        expect(Buffer.byteLength(value.configuration)).toBe(262144);
        expect(await f.advance(value)).toEqual({ state: 'pending' });
        expect(Buffer.byteLength([...f.executions.values()][0].input)).toBeLessThan(2048);
    });
    it('requires temporary credentials and fixed same-account/version settings', async () => {
        const f = fixture();
        for (const changed of [{ accountId: '999999999999' }, { region: 'eu-west-1' },
            { stateMachineVersionArn: settings.stateMachineVersionArn.slice(0, -2) }, { bucket: 'https://evil.invalid' }]) {
            expect(() => createAwsConfigurationTransport({ ...f.options, settings: { ...settings, ...changed } } as AwsConfigurationTransportOptions))
                .toThrow('aws_configuration_invalid');
        }
        const invalid = createAwsConfigurationTransport({ ...f.options, credentials: async () => ({ ...await credentials(), sessionToken: '' }) });
        cleanup.push(invalid.destroy);
        await expect(invalid.advancePreparation(work(), new AbortController().signal)).rejects.toThrow('aws_configuration_invalid');
        expect(f.calls).toHaveLength(0);
    });
    it('redacts credential provider errors without a fallback request', async () => {
        const f = fixture();
        const transport = createAwsConfigurationTransport({ ...f.options, credentials: async () => {
            throw new Error('credential-value-and-private-provider-url');
        } }); cleanup.push(transport.destroy);
        await expect(transport.advancePreparation(work(), new AbortController().signal)).rejects.toThrow(/^aws_configuration_unavailable$/);
        expect(f.calls).toHaveLength(0);
    });
    it.each(['ok', 'scope', 'origin', 'key', 'account', 'binary', 'stage'])('resolves only the current scoped host binding: %s', async kind => {
        const f = fixture(), { scope } = work(), key = 'ab'.repeat(32);
        const name = `pilot/computers/${scope.computerId}/generations/2/control`;
        const origin = `https://c-${scope.computerId}-g2.control.ezil.org`;
        const binding = { schemaVersion: 1, scope, origin, keyHex: key };
        if (kind === 'scope') binding.scope = { ...scope, fenceToken: randomUUID() };
        if (kind === 'origin') binding.origin = 'https://evil.invalid';
        if (kind === 'key') binding.keyHex = 'secret-value-must-not-leak';
        f.secret({ Name: name, ARN: `arn:aws:secretsmanager:us-east-1:${kind === 'account' ? '999999999999' : settings.accountId}:secret:${name}-abcdef`,
            VersionStages: [kind === 'stage' ? 'AWSPREVIOUS' : 'AWSCURRENT'], SecretString: JSON.stringify(binding),
            ...(kind === 'binary' ? { SecretBinary: Buffer.from('secret').toString('base64') } : {}) });
        const resolved = f.transport.resolveHost(scope, new AbortController().signal);
        if (kind !== 'ok') {
            await expect(resolved).rejects.toThrow(/^aws_host_binding_invalid$/); return;
        }
        const client = await resolved; expect(client.scope).toEqual(scope);
        const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
            const headers = init.headers as Record<string, string>, body = Buffer.from(init.body as Uint8Array);
            const message = `ezil-supervisor-v1\nPOST\n/v1/control\n${headers['x-ezil-timestamp']}\n${headers['x-ezil-nonce']}\n${createHash('sha256').update(body).digest('hex')}`;
            expect(headers['x-ezil-signature']).toBe(createHmac('sha256', Buffer.from(key, 'hex')).update(message).digest('hex'));
            return Response.json({ computerId: scope.computerId, computerGeneration: 2, configurationRevision: 4, configurationDigest: 'a'.repeat(64) });
        });
        vi.stubGlobal('fetch', fetcher); await client.configuration();
        expect(fetcher.mock.calls[0][0]).toBe(`${origin}/v1/control`);
        expect(f.calls[0].text).toContain('AWSCURRENT');
        expect(f.calls[0].text).not.toContain(key);
    });
});
