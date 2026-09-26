import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsComputerStartTransport, type AwsComputerStartTransportOptions } from './aws-computer-start-transport';
import { ComputerStartWorkSchema, type ComputerStartWork } from './computer-start-protocol';
import { computerControlKeyIdentity } from './computer-control-key';
import { lifecycleDeployment as deployment } from '../../../tests/fixtures/lifecycle';

const settings = { region: 'us-east-1' as const, accountId: deployment.accountId, namespace: deployment.namespace,
    bucket: 'ezil-start-test', kmsKeyArn: deployment.dataKeyArn,
    stateMachineVersionArn: `arn:aws:states:us-east-1:${deployment.accountId}:stateMachine:start:7` };
const credentials = async () => ({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'fixture-secret', sessionToken: 'fixture-session',
    expiration: new Date(Date.now()+3600000) });
const bytes = Buffer.from('{"prepared":"fixture"}');
function work(): ComputerStartWork {
    const scope = { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-0123456789abcdef0',
        dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() };
    const policy = { accountId: deployment.accountId, region: deployment.region, namespace: deployment.namespace,
        controlDomain: 'control.example.com', kmsKeyArn: deployment.dataKeyArn }, issuedAt = Math.floor(Date.now()/1000);
    return { schemaVersion: 1, authorizationId: randomUUID(), mountAuthorizationId: randomUUID(), scope, deployment,
        configuration: { configurationId: randomUUID(), revision: 1, digest: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length },
        controlKey: { versionId: randomUUID(), policy, secretArn: `${computerControlKeyIdentity(policy, { scope }).arnPrefix}Ab12Cd` },
        issuedAt, expiresAt: issuedAt+300 };
}
const receipt = (w: ComputerStartWork) => ({ schemaVersion: 1, authorizationId: w.authorizationId, scope: w.scope, state: 'started',
    descriptor: { computerId: w.scope.computerId, computerGeneration: w.scope.computerGeneration,
        configurationRevision: w.configuration.revision, configurationDigest: w.configuration.digest } });
type Wire = { hostname: string; protocol: string; method: string; path: string; headers: Record<string, string>; body?: unknown };
type Execution = { executionArn: string; name: string; stateMachineArn: string; stateMachineVersionArn: string; stateMachineAliasArn?: string;
    input: string; startDate: number; status: string; redriveCount: number; output?: string };
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
/** Actual SDK serialization/signing, stream handling and error decoding. No AWS. */
function fixture() {
    const calls: { action: string; request: Wire; input: Record<string, unknown> }[] = [], responses: Readable[] = [];
    let execution: Execution | undefined, lost = false, missing = false, block = '', machineType = 'STANDARD';
    const artifact = { bytes, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length), 'x-amz-version-id': 'version-1',
        'x-amz-server-side-encryption': 'aws:kms', 'x-amz-server-side-encryption-aws-kms-key-id': settings.kmsKeyArn,
        'x-amz-checksum-sha256': createHash('sha256').update(bytes).digest('base64') } };
    const response = (body: string | Buffer, statusCode = 200, headers: Record<string, string> = {}) => {
        const stream = Readable.from([body]); responses.push(stream); return { response: { statusCode, headers, body: stream } };
    };
    const json = (body: unknown, status = 200) => response(JSON.stringify(body), status, { 'content-type': 'application/x-amz-json-1.0' });
    const handler = { handle: async (request: Wire) => {
        const text = request.body === undefined ? '' : typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString();
        const action = request.headers['x-amz-target']?.split('.').at(-1) ?? request.method;
        const input = text ? JSON.parse(text) as Record<string, unknown> : {};
        calls.push({ action, request, input }); if (action === block) return new Promise<never>(() => {});
        if (request.hostname === 's3.us-east-1.amazonaws.com') {
            expect(request.method).toBe('GET');
            return missing ? response('<Error><Code>NoSuchKey</Code></Error>', 404, { 'content-type': 'application/xml' }) : response(artifact.bytes, 200, artifact.headers);
        }
        if (action === 'DescribeStateMachine') return json({ stateMachineArn: settings.stateMachineVersionArn, type: machineType, status: 'ACTIVE' });
        if (action === 'DescribeExecution') return execution ? json(execution) : json({ __type: 'ExecutionDoesNotExist', message: 'PRIVATE_VALUE' }, 400);
        if (action === 'StartExecution') {
            execution = { executionArn: `arn:aws:states:us-east-1:${settings.accountId}:execution:start:${input.name}`, name: String(input.name),
                stateMachineArn: settings.stateMachineVersionArn.slice(0, -2), stateMachineVersionArn: settings.stateMachineVersionArn,
                input: String(input.input), startDate: Date.now()/1000, status: 'RUNNING', redriveCount: 0 };
            if (lost) { lost = false; throw new Error('PRIVATE_LOST_RESPONSE'); }
            return json({ executionArn: execution.executionArn, startDate: execution.startDate });
        }
        throw new Error('unexpected_sdk_operation');
    } };
    const options: AwsComputerStartTransportOptions = { settings, credentials, requestHandler: handler };
    const transport = createAwsComputerStartTransport(options); cleanups.push(transport.destroy);
    return { calls, responses, artifact, options, transport,
        advance: (w: ComputerStartWork, signal = new AbortController().signal) => transport.advanceStart(w, signal),
        execution: () => execution!, lose: () => { lost = true; }, missing: () => { missing = true; },
        block: (action: string) => { block = action; }, express: () => { machineType = 'EXPRESS'; } };
}
describe('AWS startup delivery', () => {
    it('pins existing configuration and one workflow; pending is not a host receipt', async () => {
        const f = fixture(), w = work(); expect(await f.advance(w)).toEqual({ state: 'pending' });
        expect(f.calls.map(c => c.action)).toEqual(['GET', 'DescribeExecution', 'DescribeStateMachine', 'StartExecution']);
        const input = JSON.parse(f.execution().input); expect(input.work).toEqual(w);
        expect(input.configuration).toMatchObject({ operation: 'prepare', configurationId: w.configuration.configurationId,
            scope: w.scope, digest: w.configuration.digest, object: { versionId: 'version-1', sha256: w.configuration.digest, bytes: bytes.length } });
        expect(await f.advance(w)).toEqual({ state: 'pending' });
        f.execution().status = 'SUCCEEDED'; f.execution().output = JSON.stringify(receipt(w));
        expect(await f.advance(w)).toEqual({ state: 'started', receipt: receipt(w) });
        expect(f.calls.filter(c => c.action === 'StartExecution')).toHaveLength(1);
        expect(f.responses.every(r => r.destroyed)).toBe(true);
        for (const c of f.calls) { expect(c.request.protocol).toBe('https:'); expect(c.request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /); }
    });
    it('lost submission responses observe the same execution without another start', async () => {
        const f = fixture(), w = work(); f.lose(); expect(await f.advance(w)).toEqual({ state: 'pending' });
        expect(await f.advance(w)).toEqual({ state: 'pending' }); expect(f.calls.filter(c => c.action === 'StartExecution')).toHaveLength(1);
    });
    it('missing configuration is never written or recreated', async () => {
        const f = fixture(); f.missing(); await expect(f.advance(work())).rejects.toMatchObject({ message: 'aws_start_unavailable' });
        expect(f.calls.map(c => c.action)).toEqual(['GET']);
    });
    it.each(['version', 'length', 'kms', 'checksum', 'content', 'encoding'])( 'rejects changed artifact %s', async reason => {
        const f = fixture();
        if (reason === 'version') f.artifact.headers['x-amz-version-id'] = 'null';
        if (reason === 'length') f.artifact.headers['content-length'] = '1';
        if (reason === 'kms') f.artifact.headers['x-amz-server-side-encryption-aws-kms-key-id'] = 'PRIVATE_KMS';
        if (reason === 'checksum') f.artifact.headers['x-amz-checksum-sha256'] = 'wrong';
        if (reason === 'content') f.artifact.bytes = Buffer.from('changed');
        if (reason === 'encoding') f.artifact.headers['content-type'] = 'text/plain';
        // The SDK rejects corrupted stream bytes before our digest comparison.
        await expect(f.advance(work())).rejects.toMatchObject({ message: reason === 'content' ? 'aws_start_unavailable' : 'aws_start_conflict' });
        expect(f.calls.map(c => c.action)).toEqual(['GET']); expect(f.responses.every(r => r.destroyed)).toBe(true);
    });
    it.each(['input', 'version', 'alias', 'redrive', 'time', 'receipt', 'failed', 'artifact-version'])( 'rejects conflicting execution %s', async reason => {
        const f = fixture(), w = work(); await f.advance(w); const e = f.execution();
        if (reason === 'input') e.input = '{}';
        if (reason === 'version') e.stateMachineVersionArn = settings.stateMachineVersionArn.replace(':7', ':8');
        if (reason === 'alias') e.stateMachineAliasArn = `${e.stateMachineArn}:alias`;
        if (reason === 'redrive') e.redriveCount = 1;
        if (reason === 'time') e.startDate = w.issuedAt-1;
        if (reason === 'receipt') { e.status = 'SUCCEEDED'; e.output = JSON.stringify({ ...receipt(w), authorizationId: randomUUID() }); }
        if (reason === 'failed') e.status = 'FAILED';
        if (reason === 'artifact-version') f.artifact.headers['x-amz-version-id'] = 'version-2';
        await expect(f.advance(w)).rejects.toMatchObject({ message: reason === 'failed' ? 'aws_start_workflow_failed' : 'aws_start_conflict' });
        expect(f.calls.filter(c => c.action === 'StartExecution')).toHaveLength(1);
    });
    it('strict work, expiry, exact version and temporary credentials fail before effects', async () => {
        const f = fixture(), w = work();
        expect(ComputerStartWorkSchema.safeParse({ ...w, arbitraryPort: 1234 }).success).toBe(false);
        expect(ComputerStartWorkSchema.safeParse({ ...w, expiresAt: w.expiresAt+1 }).success).toBe(false);
        expect(ComputerStartWorkSchema.safeParse({ ...w, controlKey: { ...w.controlKey, secretArn: 'private-value' } }).success).toBe(false);
        expect(ComputerStartWorkSchema.safeParse({ ...w, issuedAt: Number.MAX_SAFE_INTEGER-300, expiresAt: Number.MAX_SAFE_INTEGER }).success).toBe(true);
        await expect(f.advance({ ...w, issuedAt: w.issuedAt-400, expiresAt: w.expiresAt-400 })).rejects.toMatchObject({ message: 'aws_start_expired' });
        expect(f.calls).toHaveLength(0);
        expect(() => createAwsComputerStartTransport({ ...f.options, settings: { ...settings, stateMachineVersionArn: settings.stateMachineVersionArn.slice(0,-2) } })).toThrow('aws_start_invalid');
        const t = createAwsComputerStartTransport({ ...f.options, credentials: async () => ({ ...await credentials(), sessionToken: '' }) }); cleanups.push(t.destroy);
        await expect(t.advanceStart(w, new AbortController().signal)).rejects.toMatchObject({ message: 'aws_start_invalid' }); expect(f.calls).toHaveLength(0);
        f.express(); await expect(f.advance(w)).rejects.toMatchObject({ message: 'aws_start_conflict' });
        expect(f.calls.some(c => c.action === 'StartExecution')).toBe(false);
    });
    it('abort and ignored-signal timeout cannot reach a success path', async () => {
        const f = fixture(), w = work(), controller = new AbortController(); controller.abort();
        await expect(f.advance(w, controller.signal)).rejects.toMatchObject({ message: 'aws_start_unavailable' }); expect(f.calls).toHaveLength(0);
        vi.useFakeTimers(); f.block('GET'); const result = expect(f.advance(w)).rejects.toMatchObject({ message: 'aws_start_unavailable' });
        await vi.waitFor(() => expect(f.calls).toHaveLength(1)); await vi.advanceTimersByTimeAsync(12000); await result;
    });
});
