import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAwsComputerControlKeys, type AwsComputerControlKeyOptions } from './aws-computer-control-key';
import { computerControlKeyIdentity, type ComputerControlKeyWork } from './computer-control-key';

const policy = { region: 'us-east-1' as const, accountId: '123456789012', namespace: 'pilot', controlDomain: 'control.example.com',
    kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
const credentials = async () => ({ accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'fixture-key',
    sessionToken: 'fixture-session', expiration: new Date(Date.now() + 3600000) });
function work(): ComputerControlKeyWork {
    return { versionId: randomUUID(), attemptedAt: new Date().toISOString(), secretArn: null,
        scope: { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-11111111111111111',
            dataVolumeId: 'vol-11111111111111111', fenceToken: randomUUID() } };
}
type WireRequest = { hostname: string; protocol: string; headers: Record<string, string>; body: unknown };
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
    const calls: { action: string; request: WireRequest; input: Record<string, unknown> }[] = [];
    let stored: { metadata: Record<string, unknown>; value: Record<string, unknown> } | undefined;
    let lost = false, exists = false, block = '', late = false;
    const json = (body: unknown, statusCode = 200) => ({ response: { statusCode, headers: { 'content-type': 'application/x-amz-json-1.1' },
        body: Readable.from([JSON.stringify(body)]) } });
    const seed = (w: ComputerControlKeyWork, keyHex = 'ab'.repeat(32)) => {
        const { name, arnPrefix, origin } = computerControlKeyIdentity(policy, w), arn = `${arnPrefix}Ab12Cd`;
        stored = { metadata: { Name: name, ARN: arn, KmsKeyId: policy.kmsKeyArn, VersionIdsToStages: { [w.versionId]: ['AWSCURRENT'] },
            Tags: Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': policy.namespace,
                'ezil:computer-id': w.scope.computerId, 'ezil:generation': String(w.scope.computerGeneration),
                'ezil:fence-token': w.scope.fenceToken }).map(([Key, Value]) => ({ Key, Value })) },
        value: { ARN: arn, Name: name, VersionId: w.versionId, VersionStages: ['AWSCURRENT'],
            SecretString: JSON.stringify({ schemaVersion: 1, scope: w.scope, origin, keyHex }) } };
        return stored;
    };
    const handler = { handle: async (request: WireRequest, options?: { abortSignal?: AbortSignal }) => {
        const text = typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array).toString('utf8');
        const input = JSON.parse(text) as Record<string, unknown>, action = request.headers['x-amz-target']!.split('.').at(-1)!;
        calls.push({ action, input, request });
        if (action === block) return new Promise<ReturnType<typeof json>>(resolve => {
            if (late) options?.abortSignal?.addEventListener('abort', () => resolve(json(stored?.value)), { once: true });
        });
        if (action === 'CreateSecret') {
            const value = JSON.parse(input.SecretString as string);
            seed({ versionId: input.ClientRequestToken as string, attemptedAt: new Date().toISOString(), secretArn: null, scope: value.scope }, value.keyHex);
            if (lost) { lost = false; throw new Error('private_provider_details'); }
            if (exists) { exists = false; return json({ __type: 'ResourceExistsException', message: 'private_provider_details' }, 400); }
            return json({ ARN: stored!.value.ARN, Name: input.Name, VersionId: input.ClientRequestToken });
        }
        if (!stored) return json({ __type: 'ResourceNotFoundException', message: 'private_provider_details' }, 400);
        if (action === 'DescribeSecret') return json(stored.metadata);
        if (action === 'GetSecretValue') return json(stored.value);
        throw new Error('unexpected_aws_operation');
    } };
    const options: AwsComputerControlKeyOptions = { policy, credentials, requestHandler: handler };
    const transport = createAwsComputerControlKeys(options); cleanup.push(transport.destroy);
    const prepare = (w: ComputerControlKeyWork, mode: 'create' | 'observe' = 'create', signal = new AbortController().signal) => transport.prepare(w, mode, signal);
    return { options, transport, prepare, calls, seed, remove: () => { stored = undefined; },
        lose: () => { lost = true; }, exists: () => { exists = true; },
        block: (action: string, replyOnAbort = false) => { block = action; late = replyOnAbort; } };
}

describe('computer control keys over the real SDK wire', () => {
    it('creates one pinned, KMS-encrypted scoped key and independently verifies it without returning values', async () => {
        const f = fixture(), w = work(), result = await f.prepare(w);
        expect(f.calls.map(c => c.action)).toEqual(['DescribeSecret', 'CreateSecret', 'DescribeSecret', 'GetSecretValue']);
        expect(result).toEqual({ state: 'confirmed', versionId: w.versionId, secretArn: `${computerControlKeyIdentity(policy, w).arnPrefix}Ab12Cd` });
        const created = f.calls[1]!.input;
        expect(created).toMatchObject({ Name: computerControlKeyIdentity(policy, w).name, ClientRequestToken: w.versionId, KmsKeyId: policy.kmsKeyArn });
        const payload = JSON.parse(created.SecretString as string);
        expect(payload).toEqual({ schemaVersion: 1, scope: w.scope, origin: computerControlKeyIdentity(policy, w).origin, keyHex: expect.stringMatching(/^[a-f0-9]{64}$/) });
        expect(JSON.stringify(result)).not.toContain(payload.keyHex);
        expect(f.calls[3]!.input).toEqual({ SecretId: result.state === 'confirmed' ? result.secretArn : '', VersionId: w.versionId, VersionStage: 'AWSCURRENT' });
        for (const { request } of f.calls) {
            expect(request.hostname).toBe('secretsmanager.us-east-1.amazonaws.com'); expect(request.protocol).toBe('https:');
            expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
        }
    });
    it('existing exact versions are observed without writes; missing historical keys never get recreated', async () => {
        const f = fixture(), w = work(); f.seed(w);
        const confirmed = await f.prepare(w, 'observe'); expect(confirmed.state).toBe('confirmed');
        expect(f.calls.map(c => c.action)).toEqual(['DescribeSecret', 'GetSecretValue']);
        f.remove(); expect(await f.prepare(w, 'observe')).toEqual({ state: 'missing' });
        expect(f.calls.some(c => c.action === 'CreateSecret')).toBe(false);
    });
    it('lost creation responses recover by observation and preserve the same key/version', async () => {
        const f = fixture(), w = work(); f.lose();
        await expect(f.prepare(w)).rejects.toMatchObject({ message: 'control_key_unavailable' });
        expect((await f.prepare(w, 'observe')).state).toBe('confirmed');
        expect(f.calls.filter(c => c.action === 'CreateSecret')).toHaveLength(1);
        f.remove(); expect(await f.prepare(w, 'observe')).toEqual({ state: 'missing' });
        expect(f.calls.filter(c => c.action === 'CreateSecret')).toHaveLength(1);
    });
    it('ResourceExists is resolved by exact observation, never another create or a version update', async () => {
        const f = fixture(), w = work(); f.exists();
        expect((await f.prepare(w)).state).toBe('confirmed');
        expect(f.calls.filter(c => c.action === 'CreateSecret')).toHaveLength(1);
    });
    it('invalid policy, input, dates and old creation permission cannot reach CreateSecret', async () => {
        const f = fixture(), w = work();
        expect(() => createAwsComputerControlKeys({ ...f.options, policy: { ...policy, kmsKeyArn: 'alias/private-marker' } })).toThrow('control_key_invalid');
        for (const bad of [{ ...w, secret: 'private-marker' }, { ...w, versionId: 'invalid' },
            { ...w, attemptedAt: new Date(Date.now() + 60000).toISOString() }, { ...w, secretArn: 'arn:private-marker' }]) {
            await expect(f.prepare(bad)).rejects.toMatchObject({ message: 'control_key_invalid' });
        }
        expect(f.calls).toHaveLength(0);
        await expect(f.prepare({ ...w, attemptedAt: new Date(Date.now() - 60000).toISOString() })).rejects.toMatchObject({ message: 'control_key_invalid' });
        expect(f.calls.map(c => c.action)).toEqual(['DescribeSecret']);
    });
    it.each(['scope', 'kms', 'deleted', 'rotation', 'versions', 'stages', 'tags', 'replica', 'owner', 'arn'])(
        'rejects conflicting %s metadata before reading a key', async reason => {
            const f = fixture(), w = work(), s = f.seed(w);
            if (reason === 'scope') s.metadata.Name = 'other-computer';
            if (reason === 'kms') s.metadata.KmsKeyId = policy.kmsKeyArn.replace('11111111-', '22222222-');
            if (reason === 'deleted') s.metadata.DeletedDate = Date.now() / 1000;
            if (reason === 'rotation') s.metadata.RotationEnabled = true;
            if (reason === 'versions') s.metadata.VersionIdsToStages = { [w.versionId]: ['AWSCURRENT'], [randomUUID()]: ['AWSPREVIOUS'] };
            if (reason === 'stages') s.metadata.VersionIdsToStages = { [w.versionId]: ['AWSPENDING'] };
            if (reason === 'tags') s.metadata.Tags = [];
            if (reason === 'replica') s.metadata.ReplicationStatus = [{ Region: 'us-west-2', Status: 'InSync' }];
            if (reason === 'owner') s.metadata.OwningService = 'other';
            if (reason === 'arn') w.secretArn = `${computerControlKeyIdentity(policy, w).arnPrefix}Other1`;
            await expect(f.prepare(w, 'observe')).rejects.toMatchObject({ message: 'control_key_conflict' });
            expect(f.calls.map(c => c.action)).toEqual(['DescribeSecret']);
        });
    it.each(['version', 'stage', 'arn', 'binary', 'json', 'scope', 'origin', 'key', 'extra'])(
        'rejects conflicting %s content without leaking the response', async reason => {
            const f = fixture(), w = work(), s = f.seed(w), body = JSON.parse(s.value.SecretString as string);
            if (reason === 'version') s.value.VersionId = randomUUID();
            if (reason === 'stage') s.value.VersionStages = ['AWSPREVIOUS'];
            if (reason === 'arn') s.value.ARN = 'private-marker';
            if (reason === 'binary') s.value.SecretBinary = 'AA==';
            if (reason === 'json') s.value.SecretString = 'private-marker';
            if (reason === 'scope') body.scope.computerId = randomUUID();
            if (reason === 'origin') body.origin = 'https://other.example.com';
            if (reason === 'key') body.keyHex = 'private-marker';
            if (reason === 'extra') body.cloudCredential = 'private-marker';
            if (['scope', 'origin', 'key', 'extra'].includes(reason)) s.value.SecretString = JSON.stringify(body);
            await expect(f.prepare(w, 'observe')).rejects.toMatchObject({ message: 'control_key_conflict' });
        });
    it('requires valid temporary credentials and does not use the default provider chain', async () => {
        for (const change of [{ accessKeyId: 'AKIAABCDEFGHIJKLMNOP' }, { sessionToken: '' }, { expiration: new Date('invalid') }]) {
            const f = fixture();
            const t = createAwsComputerControlKeys({ ...f.options, credentials: async () => ({ ...await credentials(), ...change }) }); cleanup.push(t.destroy);
            await expect(t.prepare(work(), 'observe', new AbortController().signal)).rejects.toMatchObject({ message: 'control_key_invalid' });
            expect(f.calls).toHaveLength(0);
        }
    });
    it('already-aborted work has no credential or AWS calls', async () => {
        const f = fixture(), auth = vi.fn(credentials), t = createAwsComputerControlKeys({ ...f.options, credentials: auth }); cleanup.push(t.destroy);
        const c = new AbortController(); c.abort();
        await expect(t.prepare(work(), 'create', c.signal)).rejects.toMatchObject({ message: 'control_key_unavailable' });
        expect(auth).not.toHaveBeenCalled(); expect(f.calls).toHaveLength(0);
    });
    it('timeout rejects even a valid-looking value returned during abort', async () => {
        vi.useFakeTimers(); const f = fixture(), w = work(); f.seed(w); f.block('GetSecretValue', true);
        const result = expect(f.prepare(w, 'observe')).rejects.toMatchObject({ message: 'control_key_unavailable' });
        await vi.waitFor(() => expect(f.calls.some(c => c.action === 'GetSecretValue')).toBe(true));
        await vi.advanceTimersByTimeAsync(12000); await result;
    });
});
