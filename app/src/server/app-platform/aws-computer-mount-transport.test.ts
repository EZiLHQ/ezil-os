import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsComputerMountTransport, type AwsComputerMountTransportOptions } from './aws-computer-mount-transport';
import type { ComputerMountWork } from './computer-mount-protocol';
import { canonicalConfiguration } from './computer-configuration';
import { lifecycleDeployment as deployment } from '../../../tests/fixtures/lifecycle';

const settings = { region: 'us-east-1' as const, accountId: deployment.accountId, namespace: deployment.namespace,
    bucket: 'ezil-mount-test', kmsKeyArn: deployment.dataKeyArn,
    stateMachineVersionArn: `arn:aws:states:us-east-1:${deployment.accountId}:stateMachine:mount:7` };
const credentials = async () => ({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'test-secret', sessionToken: 'test-session',
    expiration: new Date(Date.now() + 3600000) });
function work(mode: 'initialize' | 'mount' = 'initialize'): ComputerMountWork {
    const scope = { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-0123456789abcdef0',
        dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() };
    const plan = { computerId: scope.computerId, filesystemUuid: randomUUID(), mode, schemaVersion: 1 as const, volumeId: scope.dataVolumeId };
    const issuedAt = Math.floor(Date.now() / 1000);
    return { plan, deployment, authorization: { schemaVersion: 1, authorizationId: randomUUID(), scope,
        mode, filesystemUuid: plan.filesystemUuid, digest: createHash('sha256').update(canonicalConfiguration(plan)).digest('hex'),
        issuedAt, expiresAt: issuedAt + 900 } };
}
type Wire = { hostname: string; protocol: string; method: string; path: string; headers: Record<string, string>; body?: unknown };
type Execution = { executionArn: string; name: string; stateMachineArn: string; stateMachineVersionArn: string; stateMachineAliasArn?: string;
    input: string; startDate: number; status: string; redriveCount: number; output?: string };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });
/** Exercises actual SDK serializers, SigV4, XML errors, JSON and body streams.
 * No AWS resources, workflow execution, SSM or IAM permissions are exercised. */
function fixture() {
    const calls: (Wire & { text: string; action: string })[] = [];
    const objects = new Map<string, { bytes: Buffer; headers: Record<string, string> }>();
    const executions = new Map<string, Execution>(), responses: Readable[] = [];
    let losePut = false, loseStart = false, block = '', machineType = 'STANDARD';
    const effects = new Map<string, () => void>();
    const response = (statusCode: number, body: string | Buffer, headers: Record<string, string> = {}) => {
        const stream = Readable.from([body]); responses.push(stream);
        return { response: { statusCode, headers, body: stream } };
    };
    const json = (body: unknown, status = 200) => response(status, JSON.stringify(body), { 'content-type': 'application/x-amz-json-1.0' });
    const error = (name: string) => json({ __type: name, message: 'PRIVATE_PROVIDER_VALUE' }, 400);
    const handler = { handle: async (request: Wire) => {
        const text = request.body === undefined ? '' : typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString();
        const action = request.headers['x-amz-target']?.split('.').at(-1) ?? request.method;
        calls.push({ ...request, text, action }); effects.get(action)?.();
        if (action === block) return new Promise<never>(() => {});
        if (request.hostname === 's3.us-east-1.amazonaws.com') {
            if (request.method === 'PUT') {
                if (objects.has(request.path)) return response(412, '<Error><Code>PreconditionFailed</Code></Error>', { 'content-type': 'application/xml' });
                const bytes = Buffer.from(request.body as Uint8Array);
                objects.set(request.path, { bytes, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length),
                    'x-amz-version-id': 'version-1', 'x-amz-server-side-encryption': 'aws:kms',
                    'x-amz-server-side-encryption-aws-kms-key-id': settings.kmsKeyArn,
                    'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64') } });
                if (losePut) { losePut = false; throw new Error('PRIVATE_LOST_PUT'); }
                return response(200, '', { 'x-amz-version-id': 'version-1' });
            }
            const object = objects.get(request.path);
            return object ? response(200, object.bytes, object.headers)
                : response(404, '<Error><Code>NoSuchKey</Code></Error>', { 'content-type': 'application/xml' });
        }
        const input = JSON.parse(text);
        if (action === 'DescribeStateMachine') return json({ stateMachineArn: input.stateMachineArn, type: machineType, status: 'ACTIVE' });
        if (action === 'DescribeExecution') return executions.has(input.executionArn) ? json(executions.get(input.executionArn)) : error('ExecutionDoesNotExist');
        if (action === 'StartExecution') {
            const arn = `arn:aws:states:us-east-1:${settings.accountId}:execution:mount:${input.name}`;
            const existing = executions.get(arn);
            if (existing && existing.input !== input.input) return error('ExecutionAlreadyExists');
            executions.set(arn, existing ?? { executionArn: arn, name: input.name, input: input.input,
                stateMachineArn: settings.stateMachineVersionArn.slice(0, -2), stateMachineVersionArn: settings.stateMachineVersionArn,
                startDate: Date.now() / 1000, status: 'RUNNING', redriveCount: 0 });
            if (loseStart) { loseStart = false; throw new Error('PRIVATE_LOST_START'); }
            return json({ executionArn: arn, startDate: Date.now() / 1000 });
        }
        throw new Error('unexpected_aws_operation');
    } };
    const options: AwsComputerMountTransportOptions = { settings, credentials, requestHandler: handler };
    const transport = createAwsComputerMountTransport(options); cleanups.push(transport.destroy);
    const advance = (w: ComputerMountWork) => transport.advanceMount(w, new AbortController().signal);
    const mounted = (w: ComputerMountWork) => {
        const a = w.authorization, e = executions.get(`arn:aws:states:us-east-1:${settings.accountId}:execution:mount:mount-${a.authorizationId}`)!;
        e.status = 'SUCCEEDED'; e.output = JSON.stringify({ schemaVersion: 1, authorizationId: a.authorizationId,
            scope: a.scope, digest: a.digest, state: 'mounted', computerId: w.plan.computerId, volumeId: w.plan.volumeId, filesystemUuid: w.plan.filesystemUuid });
        return e;
    };
    return { options, transport, calls, objects, executions, responses, advance, mounted, effects,
        loseResponses() { losePut = true; loseStart = true; }, block(action: string) { block = action; }, express() { machineType = 'EXPRESS'; } };
}

describe('AWS computer mount transport', () => {
    it.each(['initialize', 'mount'] as const)('stages exact %s content and verifies the immutable workflow receipt', async mode => {
        const f = fixture(), w = work(mode); vi.stubEnv('AWS_ENDPOINT_URL', 'https://unapproved.invalid');
        expect(await f.advance(w)).toEqual({ state: 'pending' });
        const put = f.calls.find(c => c.action === 'PUT')!;
        expect(put.text).toBe(canonicalConfiguration(w.plan));
        expect(put.path).toBe(`/${settings.bucket}/${settings.namespace}/computers/${w.plan.computerId}/generations/1/data-mounts/${w.authorization.authorizationId}.json`);
        expect(put.headers).toMatchObject({ 'if-none-match': '*', 'x-amz-expected-bucket-owner': settings.accountId,
            'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': settings.kmsKeyArn });
        for (const c of f.calls) {
            expect(c.protocol).toBe('https:'); expect(['s3.us-east-1.amazonaws.com', 'states.us-east-1.amazonaws.com']).toContain(c.hostname);
            expect(c.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
        }
        const e = f.mounted(w), envelope = JSON.parse(e.input);
        expect(envelope).toMatchObject({ schemaVersion: 1, work: w, object: { versionId: 'version-1', sha256: w.authorization.digest } });
        expect(e.input).not.toContain('test-secret'); expect(e.input).not.toContain('test-session');
        expect(await f.advance(w)).toEqual({ state: 'mounted', receipt: JSON.parse(e.output!) });
        expect(f.calls.filter(c => c.action === 'PUT')).toHaveLength(1);
        expect(f.calls.filter(c => c.action === 'StartExecution')).toHaveLength(1);
    });
    it('handles lost replies and concurrent polls without allocating new object/execution identities', async () => {
        const f = fixture(), w = work(); f.loseResponses();
        expect(await Promise.all([f.advance(w), f.advance(w)])).toEqual([{ state: 'pending' }, { state: 'pending' }]);
        expect(f.objects.size).toBe(1); expect(f.executions.size).toBe(1);
        expect(await f.advance(w)).toEqual({ state: 'pending' });
    });
    it('keeps two computers in independent paths and executions', async () => {
        const f = fixture(), a = work(), b = work(); await f.advance(a); await f.advance(b);
        expect(f.objects.size).toBe(2); expect(f.executions.size).toBe(2);
        await expect(f.advance({ ...a, authorization: { ...a.authorization, scope: { ...a.authorization.scope, fenceToken: randomUUID() } } }))
            .rejects.toThrow('aws_mount_conflict');
    });
    it.each(['digest', 'unknown', 'mode', 'account', 'namespace', 'oversized', 'expired', 'future'])('rejects %s before AWS access', async kind => {
        const f = fixture(), w = work();
        if (kind === 'digest') w.authorization.digest = '0'.repeat(64);
        if (kind === 'unknown') Object.assign(w, { bucket: 'caller-selected' });
        if (kind === 'mode') w.plan.mode = 'mount';
        if (kind === 'account') w.deployment = { ...deployment, accountId: '999999999999' };
        if (kind === 'namespace') w.deployment = { ...deployment, namespace: 'unapproved' };
        if (kind === 'oversized') w.deployment = { ...deployment, stateMachineVersionArn: deployment.stateMachineVersionArn+'1'.repeat(20000) };
        if (kind === 'expired' || kind === 'future') { w.authorization.issuedAt += kind === 'expired' ? -1000 : 1000; w.authorization.expiresAt = w.authorization.issuedAt + 900; }
        await expect(f.advance(w)).rejects.toThrow(/^aws_mount_(invalid|expired)$/); expect(f.calls).toHaveLength(0);
    });
    it.each(['version', 'changed-version', 'kms', 'encryption', 'content-type', 'checksum', 'bytes', 'length', 'oversized-stream'])('rejects staged %s mismatch', async kind => {
        const f = fixture(), w = work(); await f.advance(w); const obj = [...f.objects.values()][0];
        if (kind === 'version') obj.headers['x-amz-version-id'] = 'null';
        if (kind === 'changed-version') obj.headers['x-amz-version-id'] = 'version-2';
        if (kind === 'kms') obj.headers['x-amz-server-side-encryption-aws-kms-key-id'] = settings.kmsKeyArn.replace(settings.accountId, '999999999999');
        if (kind === 'encryption') obj.headers['x-amz-server-side-encryption'] = 'AES256';
        if (kind === 'content-type') obj.headers['content-type'] = 'text/html';
        if (kind === 'checksum') obj.headers['x-amz-checksum-sha256'] = Buffer.alloc(32).toString('base64');
        if (kind === 'bytes') obj.bytes[0] = 0;
        if (kind === 'length') obj.headers['content-length'] = '999999';
        if (kind === 'oversized-stream') obj.bytes = Buffer.alloc(65536);
        await expect(f.advance(w)).rejects.toThrow(/^aws_mount_(conflict|unavailable)$/);
        expect(f.calls.filter(c => c.action === 'PUT')).toHaveLength(1);
        expect(f.calls.filter(c => c.action === 'StartExecution')).toHaveLength(1);
        expect(f.responses.every(r => r.destroyed)).toBe(true);
    });
    it.each(['FAILED', 'TIMED_OUT', 'ABORTED', 'PENDING_REDRIVE'])('never restarts %s work', async status => {
        const f = fixture(), w = work(); await f.advance(w); f.mounted(w).status = status;
        await expect(f.advance(w)).rejects.toThrow('aws_mount_workflow_failed');
        expect(f.calls.filter(c => c.action === 'StartExecution')).toHaveLength(1);
    });
    it.each(['input', 'version', 'alias', 'redrive', 'start-date', 'scope', 'output', 'extra'])('rejects changed execution %s', async kind => {
        const f = fixture(), w = work(); await f.advance(w); const e = f.mounted(w);
        if (kind === 'input') e.input += ' ';
        if (kind === 'version') e.stateMachineVersionArn = settings.stateMachineVersionArn.replace(':7', ':8');
        if (kind === 'alias') e.stateMachineAliasArn = 'unapproved';
        if (kind === 'redrive') e.redriveCount = 1;
        if (kind === 'start-date') e.startDate = w.authorization.issuedAt - 1;
        if (kind === 'scope') e.output = JSON.stringify({ ...JSON.parse(e.output!), scope: work().authorization.scope });
        if (kind === 'output') e.output = '{}';
        if (kind === 'extra') e.output = JSON.stringify({ ...JSON.parse(e.output!), ready: true });
        await expect(f.advance(w)).rejects.toThrow('aws_mount_conflict');
    });
    it('rejects Express and expiry during staging before starting a workflow', async () => {
        const f = fixture(), w = work(); f.express();
        await expect(f.advance(w)).rejects.toThrow('aws_mount_conflict'); expect(f.executions.size).toBe(0);
        const g = fixture(), next = work();
        g.effects.set('PUT', () => { vi.spyOn(Date, 'now').mockReturnValue(next.authorization.expiresAt * 1000); });
        await expect(g.advance(next)).rejects.toThrow('aws_mount_expired'); expect(g.executions.size).toBe(0);
        expect(g.calls.some(c => c.action === 'StartExecution')).toBe(false);
    });
    it('bounds ignored abort signals without claiming cancellation of remote work', async () => {
        const f = fixture(), controller = new AbortController(); f.block('GET');
        const pending = f.transport.advanceMount(work(), controller.signal), rejected = expect(pending).rejects.toThrow('aws_mount_unavailable');
        await vi.waitFor(() => expect(f.calls).toHaveLength(1)); controller.abort(); await rejected; expect(f.calls).toHaveLength(1);
        const g = fixture(); g.block('GET'); vi.useFakeTimers();
        const timed = expect(g.advance(work())).rejects.toThrow('aws_mount_unavailable');
        await vi.advanceTimersByTimeAsync(8100); await timed; expect(g.calls).toHaveLength(1);
    });
    it('requires temporary credentials and same-account immutable settings, redacting failures', async () => {
        const f = fixture();
        for (const changed of [{ stateMachineVersionArn: settings.stateMachineVersionArn.slice(0, -2) }, { accountId: '999999999999' },
            { bucket: 'https://unapproved.invalid' }, { region: 'eu-west-1' }]) {
            expect(() => createAwsComputerMountTransport({ ...f.options, settings: { ...settings, ...changed } } as AwsComputerMountTransportOptions))
                .toThrow('aws_mount_invalid');
        }
        for (const credential of [async () => ({ ...await credentials(), accessKeyId: 'AKIAABCDEFGHIJKLMNOP' }),
            async () => { throw new Error('PRIVATE_CREDENTIAL'); }]) {
            const t = createAwsComputerMountTransport({ ...f.options, credentials: credential }); cleanups.push(t.destroy);
            await expect(t.advanceMount(work(), new AbortController().signal)).rejects.toThrow(/^aws_mount_(invalid|unavailable)$/);
        }
        expect(f.calls).toHaveLength(0);
    });
});
