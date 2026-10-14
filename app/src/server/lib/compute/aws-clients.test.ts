/**
 * The app's AWS clients (aws-clients.ts). No network: logic tests use fakes at
 * the SDK `send` boundary, and the wiring tests run the REAL SDK clients
 * (credentials, signing, serialization) against a stub HTTP layer.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    AwsClientError,
    appCallerRoleEnv,
    createAwsSdkCollaborators,
    createEc2EnrollmentDescriber,
    createSfnExecutionReader,
    createSfnLifecycleStarter,
    CREDENTIAL_MARGIN_MS,
    readVercelOidcToken,
    sharedAwsSdkCollaborators,
    toAwsClientError,
    webIdentityCredentials,
    type RegionalClient,
    type Sender,
} from './aws-clients';

const R = 'us-east-1';
const A = '123456789012';
const ROLE = `arn:aws:iam::${A}:role/ezil/pilot/ezil-app-caller`;
const VERSION = `arn:aws:states:${R}:${A}:stateMachine:ezil-pilot-lifecycle:3`;
const JOB = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
const NAME = `computer-${JOB}`;
const EXECUTION = `arn:aws:states:${R}:${A}:execution:ezil-pilot-lifecycle:${NAME}`;
const NOW = new Date('2026-10-14T10:00:00Z');
const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

const awsError = (name: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('aws says no about some-resource'), { name, ...extra });
const cmdName = (c: unknown) => (c as { constructor: { name: string } }).constructor.name;
const input = (c: unknown) => (c as { input: Record<string, unknown> }).input;

function fakeSender(handler: (command: unknown) => unknown): Sender & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
        calls,
        async send(command: unknown) {
            calls.push(command);
            return handler(command);
        },
    };
}
const regional = (client: Sender, account = A) => (): RegionalClient => ({ client, account });

afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
});

describe('error mapping', () => {
    it.each([
        ['ThrottlingException', 'aws_throttled', true],
        ['RequestLimitExceeded', 'aws_throttled', true],
        ['InsufficientInstanceCapacity', 'aws_capacity', false],
        ['ExecutionLimitExceeded', 'aws_capacity', false],
        ['VcpuLimitExceeded', 'aws_capacity', false],
        ['AccessDeniedException', 'aws_config', false],
        ['UnauthorizedOperation', 'aws_config', false],
        ['StateMachineDoesNotExist', 'aws_config', false],
        ['InvalidIdentityToken', 'aws_caller_unavailable', false],
        ['SomethingElse', 'aws_error', false],
    ] as const)('%s → %s', (name, code, retryable) => {
        const e = toAwsClientError(awsError(name));
        expect(e).toMatchObject({ code, retryable, awsName: name });
        // AWS messages can name resources: never carried.
        expect(e.message).not.toContain('some-resource');
    });
    it('HTTP 429/5xx and $retryable are throttling; an AwsClientError passes through', () => {
        expect(toAwsClientError(awsError('X', { $metadata: { httpStatusCode: 503 } })).code).toBe('aws_throttled');
        expect(toAwsClientError(awsError('X', { $metadata: { httpStatusCode: 429 } })).code).toBe('aws_throttled');
        expect(toAwsClientError(awsError('X', { $retryable: {} })).code).toBe('aws_throttled');
        const own = new AwsClientError('aws_config', false, 'Own');
        expect(toAwsClientError(own)).toBe(own);
        expect(toAwsClientError(undefined).code).toBe('aws_error');
    });
});

describe('Vercel OIDC token', () => {
    it('the request context header wins over the file and the variable', () => {
        (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ headers: { 'x-vercel-oidc-token': ' hdr-token ' } }) };
        const readFile = vi.fn(() => 'file-token');
        expect(readVercelOidcToken({ VERCEL_OIDC_TOKEN_FILE: '/t', VERCEL_OIDC_TOKEN: 'env-token' }, readFile)).toBe('hdr-token');
        expect(readFile).not.toHaveBeenCalled();
    });
    it('without a header: the file (trimmed), read on every call', () => {
        let content = 'file-1\n';
        const readFile = vi.fn(() => content);
        expect(readVercelOidcToken({ VERCEL_OIDC_TOKEN_FILE: '/t', VERCEL_OIDC_TOKEN: 'env-token' }, readFile)).toBe('file-1');
        content = 'file-2';
        expect(readVercelOidcToken({ VERCEL_OIDC_TOKEN_FILE: '/t', VERCEL_OIDC_TOKEN: 'env-token' }, readFile)).toBe('file-2');
    });
    it('an unreadable or empty configured file is an error, never a fallback to the variable', () => {
        const unreadable = () => {
            throw new Error('ENOENT');
        };
        expect(() => readVercelOidcToken({ VERCEL_OIDC_TOKEN_FILE: '/t', VERCEL_OIDC_TOKEN: 'env-token' }, unreadable)).toThrow(/aws_caller_unavailable/);
        expect(() => readVercelOidcToken({ VERCEL_OIDC_TOKEN_FILE: '/t', VERCEL_OIDC_TOKEN: 'env-token' }, () => '  ')).toThrow(/aws_caller_unavailable/);
    });
    it('then the variable; nothing → null', () => {
        expect(readVercelOidcToken({ VERCEL_OIDC_TOKEN: 'env-token' })).toBe('env-token');
        expect(readVercelOidcToken({})).toBeNull();
        expect(readVercelOidcToken({ VERCEL_OIDC_TOKEN: '  ' })).toBeNull();
    });
});

const STS_OK = (expiration: Date) => ({
    Credentials: { AccessKeyId: 'ASIAASSUMED', SecretAccessKey: 'secret', SessionToken: 'session', Expiration: expiration },
});

describe('caller credentials (AssumeRoleWithWebIdentity)', () => {
    it('no token: aws_caller_unavailable and STS is never asked', async () => {
        const sts = fakeSender(() => STS_OK(new Date(NOW.getTime() + 3600_000)));
        const creds = webIdentityCredentials({ roleArn: ROLE, region: R, token: () => null, sts, now: () => NOW });
        await expect(creds()).rejects.toMatchObject({ code: 'aws_caller_unavailable' });
        expect(sts.calls).toHaveLength(0);
    });
    it('assumes the exact role with the current token and caches until expiry minus the margin', async () => {
        let now = NOW;
        const expiration = new Date(NOW.getTime() + 3600_000);
        const tokens = ['t1', 't2'];
        const sts = fakeSender(() => STS_OK(expiration));
        const creds = webIdentityCredentials({ roleArn: ROLE, region: R, token: () => tokens.shift() ?? null, sts, now: () => now });
        const first = await creds();
        expect(first).toEqual({ accessKeyId: 'ASIAASSUMED', secretAccessKey: 'secret', sessionToken: 'session', expiration });
        expect(cmdName(sts.calls[0])).toBe('AssumeRoleWithWebIdentityCommand');
        expect(input(sts.calls[0])).toEqual({ RoleArn: ROLE, RoleSessionName: `ezil-app-${R}`, WebIdentityToken: 't1', DurationSeconds: 3600 });
        now = new Date(expiration.getTime() - CREDENTIAL_MARGIN_MS - 1);
        await creds();
        expect(sts.calls).toHaveLength(1);
        now = new Date(expiration.getTime() - CREDENTIAL_MARGIN_MS + 1);
        await creds();
        expect(sts.calls).toHaveLength(2);
        expect(input(sts.calls[1]).WebIdentityToken).toBe('t2');
    });
    it('a refusal is aws_caller_unavailable; throttling stays retryable; incomplete credentials are refused', async () => {
        const refuse = webIdentityCredentials({ roleArn: ROLE, region: R, token: () => 't', sts: fakeSender(() => Promise.reject(awsError('AccessDenied'))) });
        await expect(refuse()).rejects.toMatchObject({ code: 'aws_caller_unavailable', awsName: 'AccessDenied' });
        const slow = webIdentityCredentials({ roleArn: ROLE, region: R, token: () => 't', sts: fakeSender(() => Promise.reject(awsError('Throttling'))) });
        await expect(slow()).rejects.toMatchObject({ code: 'aws_throttled', retryable: true });
        const partial = webIdentityCredentials({ roleArn: ROLE, region: R, token: () => 't', sts: fakeSender(() => ({ Credentials: { AccessKeyId: 'A' } })) });
        await expect(partial()).rejects.toMatchObject({ code: 'aws_caller_unavailable', awsName: 'StsCredentialsIncomplete' });
    });
    it('an invalid role ARN is a configuration error', () => {
        expect(() => webIdentityCredentials({ roleArn: 'arn:aws:iam::1:role/x', region: R, token: () => 't', sts: fakeSender(() => ({})) })).toThrow(/aws_config/);
    });
});

describe('Step Functions starter', () => {
    const work = { stateMachineArn: VERSION, name: NAME, input: '{"schemaVersion":1}' };
    it('starts the exact version ARN with the job name and input', async () => {
        const sfn = fakeSender(() => ({ executionArn: EXECUTION }));
        await createSfnLifecycleStarter(regional(sfn)).start(R, work);
        expect(cmdName(sfn.calls[0])).toBe('StartExecutionCommand');
        expect(input(sfn.calls[0])).toEqual({ stateMachineArn: VERSION, name: NAME, input: work.input });
    });
    it('refuses, before sending: an unversioned ARN, another region, another account, a bad name', async () => {
        const sfn = fakeSender(() => ({}));
        const starter = createSfnLifecycleStarter(regional(sfn));
        await expect(starter.start(R, { ...work, stateMachineArn: VERSION.replace(/:3$/, '') })).rejects.toMatchObject({ code: 'aws_config', awsName: 'StateMachineVersionArnRequired' });
        await expect(starter.start('ap-south-1', work)).rejects.toMatchObject({ code: 'aws_config', awsName: 'StateMachineRegionMismatch' });
        await expect(createSfnLifecycleStarter(regional(sfn, '999999999999')).start(R, work)).rejects.toMatchObject({ awsName: 'StateMachineAccountMismatch' });
        await expect(starter.start(R, { ...work, name: 'other' })).rejects.toMatchObject({ awsName: 'ExecutionInvalid' });
        expect(sfn.calls).toHaveLength(0);
    });
    it('ExecutionAlreadyExists is success; other failures are mapped', async () => {
        await expect(createSfnLifecycleStarter(regional(fakeSender(() => Promise.reject(awsError('ExecutionAlreadyExists'))))).start(R, work)).resolves.toBeUndefined();
        await expect(createSfnLifecycleStarter(regional(fakeSender(() => Promise.reject(awsError('ThrottlingException'))))).start(R, work)).rejects.toMatchObject({ code: 'aws_throttled', retryable: true });
        await expect(createSfnLifecycleStarter(regional(fakeSender(() => Promise.reject(awsError('ExecutionLimitExceeded'))))).start(R, work)).rejects.toMatchObject({ code: 'aws_capacity' });
        await expect(createSfnLifecycleStarter(regional(fakeSender(() => Promise.reject(awsError('AccessDeniedException'))))).start(R, work)).rejects.toMatchObject({ code: 'aws_config' });
    });
});

describe('Step Functions execution reader', () => {
    it('describes exactly the named execution and normalizes absent fields to null', async () => {
        const sfn = fakeSender(() => ({ status: 'SUCCEEDED', output: '{"ok":1}' }));
        await expect(createSfnExecutionReader(regional(sfn)).describe(R, EXECUTION)).resolves.toEqual({ status: 'SUCCEEDED', output: '{"ok":1}', error: null, cause: null });
        expect(cmdName(sfn.calls[0])).toBe('DescribeExecutionCommand');
        expect(input(sfn.calls[0])).toEqual({ executionArn: EXECUTION });
    });
    it('refuses another region, another account, or a non-computer execution before sending', async () => {
        const sfn = fakeSender(() => ({ status: 'SUCCEEDED' }));
        const reader = createSfnExecutionReader(regional(sfn));
        await expect(reader.describe('ap-south-1', EXECUTION)).rejects.toMatchObject({ awsName: 'ExecutionRegionMismatch' });
        await expect(createSfnExecutionReader(regional(sfn, '999999999999')).describe(R, EXECUTION)).rejects.toMatchObject({ awsName: 'ExecutionAccountMismatch' });
        await expect(reader.describe(R, EXECUTION.replace(NAME, 'manual-run'))).rejects.toMatchObject({ awsName: 'ExecutionArnInvalid' });
        expect(sfn.calls).toHaveLength(0);
    });
    it('maps failures and refuses an answer without a status', async () => {
        await expect(createSfnExecutionReader(regional(fakeSender(() => Promise.reject(awsError('ExecutionDoesNotExist'))))).describe(R, EXECUTION)).rejects.toMatchObject({ code: 'aws_config' });
        await expect(createSfnExecutionReader(regional(fakeSender(() => ({})))).describe(R, EXECUTION)).rejects.toMatchObject({ code: 'aws_error' });
    });
});

const INSTANCE = 'i-0123456789abcdef0';
const DATA = 'vol-0123456789abcdef0';
const ROOT = 'vol-0fedcba9876543210';
function ec2Fake(o: { placement?: Record<string, string>; volumes?: { VolumeId: string; Tags?: { Key: string; Value: string }[] }[]; dot?: boolean; zones?: unknown } = {}) {
    return fakeSender((c) => {
        switch (cmdName(c)) {
            case 'DescribeInstancesCommand':
                return {
                    Reservations: [{
                        Instances: [{
                            InstanceId: INSTANCE,
                            State: { Name: 'running' },
                            Placement: o.placement ?? { AvailabilityZone: 'us-east-1a', AvailabilityZoneId: 'use1-az1' },
                            PublicIpAddress: '203.0.113.7',
                            Tags: [{ Key: 'ezil:generation', Value: '2' }],
                            BlockDeviceMappings: [
                                { DeviceName: '/dev/xvda', Ebs: { VolumeId: ROOT, DeleteOnTermination: true } },
                                { DeviceName: '/dev/sdf', Ebs: { VolumeId: DATA, ...(o.dot === undefined ? { DeleteOnTermination: false } : {}) } },
                            ],
                        }],
                    }],
                };
            case 'DescribeVolumesCommand':
                return { Volumes: o.volumes ?? [{ VolumeId: ROOT, Tags: [] }, { VolumeId: DATA, Tags: [{ Key: 'ezil:disk-kind', Value: 'data' }] }] };
            case 'DescribeAvailabilityZonesCommand':
                return o.zones ?? { AvailabilityZones: [{ ZoneName: 'us-east-1a', ZoneId: 'use1-az1' }] };
            default:
                throw new Error(`unexpected ${cmdName(c)}`);
        }
    });
}

describe('EC2 enrollment describer', () => {
    it('maps the instance, its zone id, public IP, tags and every attached volume', async () => {
        const ec2 = ec2Fake();
        const view = await createEc2EnrollmentDescriber(regional(ec2)).describeForEnrollment(R, INSTANCE);
        expect(view).toEqual({
            instanceId: INSTANCE, state: 'running', availabilityZone: 'us-east-1a', availabilityZoneId: 'use1-az1', publicIp: '203.0.113.7',
            tags: { 'ezil:generation': '2' },
            volumes: [
                { volumeId: ROOT, deleteOnTermination: true, tags: {} },
                { volumeId: DATA, deleteOnTermination: false, tags: { 'ezil:disk-kind': 'data' } },
            ],
        });
        expect(input(ec2.calls[0])).toEqual({ InstanceIds: [INSTANCE] });
        expect(input(ec2.calls[1])).toEqual({ VolumeIds: [ROOT, DATA] });
    });
    it('a zone id missing from the placement comes from DescribeAvailabilityZones for that zone name', async () => {
        const ec2 = ec2Fake({ placement: { AvailabilityZone: 'us-east-1a' } });
        const view = await createEc2EnrollmentDescriber(regional(ec2)).describeForEnrollment(R, INSTANCE);
        expect(view?.availabilityZoneId).toBe('use1-az1');
        expect(input(ec2.calls.find((c) => cmdName(c) === 'DescribeAvailabilityZonesCommand'))).toEqual({ ZoneNames: ['us-east-1a'] });
        await expect(createEc2EnrollmentDescriber(regional(ec2Fake({ placement: { AvailabilityZone: 'us-east-1a' }, zones: { AvailabilityZones: [] } }))).describeForEnrollment(R, INSTANCE))
            .rejects.toMatchObject({ awsName: 'InstanceZoneIdMissing' });
    });
    it('an unknown DeleteOnTermination never reads as kept-on-terminate', async () => {
        const view = await createEc2EnrollmentDescriber(regional(ec2Fake({ dot: true }))).describeForEnrollment(R, INSTANCE);
        expect(view?.volumes.find((v) => v.volumeId === DATA)?.deleteOnTermination).toBe(true);
    });
    it('a partial DescribeVolumes answer is not evidence', async () => {
        await expect(createEc2EnrollmentDescriber(regional(ec2Fake({ volumes: [{ VolumeId: ROOT }] }))).describeForEnrollment(R, INSTANCE))
            .rejects.toMatchObject({ awsName: 'DescribeVolumesIncomplete' });
    });
    it('no such instance → null; a malformed id → null without asking EC2; denial is mapped', async () => {
        await expect(createEc2EnrollmentDescriber(regional(fakeSender(() => Promise.reject(awsError('InvalidInstanceID.NotFound'))))).describeForEnrollment(R, INSTANCE)).resolves.toBeNull();
        await expect(createEc2EnrollmentDescriber(regional(fakeSender(() => ({ Reservations: [] })))).describeForEnrollment(R, INSTANCE)).resolves.toBeNull();
        const ec2 = ec2Fake();
        await expect(createEc2EnrollmentDescriber(regional(ec2)).describeForEnrollment(R, 'i-nope')).resolves.toBeNull();
        expect(ec2.calls).toHaveLength(0);
        await expect(createEc2EnrollmentDescriber(regional(fakeSender(() => Promise.reject(awsError('UnauthorizedOperation'))))).describeForEnrollment(R, INSTANCE)).rejects.toMatchObject({ code: 'aws_config' });
    });
});

const ROLE_MUMBAI = `arn:aws:iam::${A}:role/ezil/pilot/ezil-app-caller-aps1`;
const ENV_ON = {
    EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_REGIONS: `ap-south-1,${R}`, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2',
    [appCallerRoleEnv(R)]: ROLE, [appCallerRoleEnv('ap-south-1')]: ROLE_MUMBAI,
};

describe('wiring from the environment', () => {
    it('AWS off (or no valid regions): nothing is built, no factory is called', () => {
        const f = { sts: vi.fn(), sfn: vi.fn(), ec2: vi.fn(), token: vi.fn() };
        expect(createAwsSdkCollaborators({}, f)).toEqual({});
        expect(createAwsSdkCollaborators({ ...ENV_ON, EZIL_AWS_COMPUTERS_ENABLED: '0' }, f)).toEqual({});
        expect(createAwsSdkCollaborators({ ...ENV_ON, AWS_REGIONS: 'nowhere' }, f)).toEqual({});
        expect(sharedAwsSdkCollaborators({})).toEqual({});
        for (const fn of Object.values(f)) expect(fn).not.toHaveBeenCalled();
    });
    it('clients are built lazily, per region, with that region\'s role; one STS session serves SFN and EC2', async () => {
        const sts = vi.fn(() => fakeSender(() => STS_OK(new Date(NOW.getTime() + 3600_000))));
        const sfnSender = fakeSender(() => ({}));
        const sfn = vi.fn<(region: string, credentials: unknown) => Sender>(() => sfnSender);
        const ec2 = vi.fn<(region: string, credentials: unknown) => Sender>(() => ec2Fake());
        const c = createAwsSdkCollaborators(ENV_ON, { sts, sfn, ec2, token: () => 't', now: () => NOW });
        expect([sts, sfn, ec2].every((m) => m.mock.calls.length === 0)).toBe(true);
        await c.starter!.start(R, { stateMachineArn: VERSION, name: NAME, input: '{}' });
        await c.starter!.start(R, { stateMachineArn: VERSION, name: NAME, input: '{}' });
        await c.describer!.describeForEnrollment(R, INSTANCE);
        expect(sfn).toHaveBeenCalledTimes(1);
        expect(sfn.mock.calls[0]![0]).toBe(R);
        expect(ec2).toHaveBeenCalledTimes(1);
        expect(sts).toHaveBeenCalledTimes(1);
        // The SFN and EC2 clients get the SAME credentials function (one cache per region).
        expect(ec2.mock.calls[0]![1]).toBe(sfn.mock.calls[0]![1]);
    });
    it('any configured region without its own (valid) caller role: nothing is built — no half-configured caller', () => {
        const f = { sts: vi.fn(), sfn: vi.fn(), ec2: vi.fn(), token: vi.fn() };
        expect(createAwsSdkCollaborators({ ...ENV_ON, [appCallerRoleEnv('ap-south-1')]: undefined }, f)).toEqual({});
        expect(createAwsSdkCollaborators({ ...ENV_ON, [appCallerRoleEnv('ap-south-1')]: 'arn:aws:iam::1:role/x' }, f)).toEqual({});
        for (const fn of Object.values(f)) expect(fn).not.toHaveBeenCalled();
    });
    it('each region uses its OWN role; a region outside AWS_REGIONS is aws_config', async () => {
        const stsSenders: (Sender & { calls: unknown[] })[] = [];
        const sts = vi.fn(() => {
            const s = fakeSender(() => STS_OK(new Date(NOW.getTime() + 3600_000)));
            stsSenders.push(s);
            return s;
        });
        // Like the SDK: resolve the credentials before sending.
        const sfn = vi.fn((_region: string, credentials: () => Promise<unknown>) => fakeSender(async () => (await credentials(), {})));
        const c = createAwsSdkCollaborators(ENV_ON, { sts, sfn, token: () => 't', now: () => NOW });
        const mumbai = `arn:aws:states:ap-south-1:${A}:stateMachine:ezil-pilot-lifecycle:1`;
        await c.starter!.start('ap-south-1', { stateMachineArn: mumbai, name: NAME, input: '{}' });
        await c.starter!.start(R, { stateMachineArn: VERSION, name: NAME, input: '{}' });
        expect(stsSenders.map((s) => input(s.calls[0]).RoleArn)).toEqual([ROLE_MUMBAI, ROLE]);
        await expect(c.starter!.start('eu-west-1', { stateMachineArn: VERSION.replace(R, 'eu-west-1'), name: NAME, input: '{}' })).rejects.toMatchObject({ code: 'aws_config', awsName: 'RegionNotConfigured' });
        expect(sfn).toHaveBeenCalledTimes(2);
    });
    it('the shared collaborators survive across calls and are rebuilt when the settings change', () => {
        const a = sharedAwsSdkCollaborators(ENV_ON);
        expect(sharedAwsSdkCollaborators({ ...ENV_ON })).toBe(a);
        expect(sharedAwsSdkCollaborators({ ...ENV_ON, [appCallerRoleEnv(R)]: ROLE.replace('ezil-app-caller', 'other') })).not.toBe(a);
    });
});

/** A stub of the SDK's HTTP layer: records every request; answers per host. */
function stubHttp(answer: (req: { hostname: string; headers: Record<string, string>; body: string }) => { status?: number; headers?: Record<string, string>; body: string }) {
    const requests: { hostname: string; headers: Record<string, string>; body: string }[] = [];
    return {
        requests,
        handler: {
            async handle(request: { hostname: string; headers: Record<string, string>; body?: unknown }) {
                const body = typeof request.body === 'string' ? request.body : request.body instanceof Uint8Array ? new TextDecoder().decode(request.body) : '';
                const req = { hostname: request.hostname, headers: request.headers, body };
                requests.push(req);
                const r = answer(req);
                return { response: { statusCode: r.status ?? 200, headers: r.headers ?? {}, body: new TextEncoder().encode(r.body) } };
            },
        },
    };
}
const STS_XML = `<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleWithWebIdentityResult><Credentials>
<AccessKeyId>ASIAASSUMEDKEY</AccessKeyId><SecretAccessKey>assumed-secret</SecretAccessKey><SessionToken>assumed-session</SessionToken>
<Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`;

describe('real SDK clients against a stub HTTP layer (no network)', () => {
    const ambient = { AWS_ACCESS_KEY_ID: 'AKIAAMBIENTKEY', AWS_SECRET_ACCESS_KEY: 'ambient-secret', AWS_SESSION_TOKEN: 'ambient-session', AWS_PROFILE: 'ambient' };
    afterEach(() => vi.unstubAllEnvs());

    it('STS is called unsigned with the token; SFN is signed with the ASSUMED key, never the ambient one', async () => {
        for (const [k, v] of Object.entries(ambient)) vi.stubEnv(k, v);
        const http = stubHttp((req) =>
            req.hostname.startsWith('sts.')
                ? { headers: { 'content-type': 'text/xml' }, body: STS_XML }
                : { headers: { 'content-type': 'application/x-amz-json-1.0' }, body: JSON.stringify({ executionArn: EXECUTION, startDate: 1791936000 }) },
        );
        const c = createAwsSdkCollaborators(ENV_ON, { token: () => 'oidc-token-value', requestHandler: http.handler });
        await c.starter!.start(R, { stateMachineArn: VERSION, name: NAME, input: '{}' });
        const [sts, sfn] = http.requests;
        expect(sts!.hostname).toBe(`sts.${R}.amazonaws.com`);
        expect(sts!.headers.authorization).toBeUndefined();
        expect(sts!.body).toContain('Action=AssumeRoleWithWebIdentity');
        expect(sts!.body).toContain('WebIdentityToken=oidc-token-value');
        expect(sts!.body).toContain(`RoleArn=${encodeURIComponent(ROLE)}`);
        expect(sfn!.hostname).toBe(`states.${R}.amazonaws.com`);
        expect(sfn!.headers['x-amz-target']).toBe('AWSStepFunctions.StartExecution');
        expect(sfn!.headers.authorization).toContain('Credential=ASIAASSUMEDKEY/');
        expect(sfn!.headers['x-amz-security-token']).toBe('assumed-session');
        expect(JSON.stringify(http.requests)).not.toContain('AKIAAMBIENTKEY');
    });

    it('no OIDC token: aws_caller_unavailable and NOTHING is sent, even with ambient keys in the environment', async () => {
        for (const [k, v] of Object.entries(ambient)) vi.stubEnv(k, v);
        const http = stubHttp(() => ({ body: '{}' }));
        const c = createAwsSdkCollaborators(ENV_ON, { token: () => null, requestHandler: http.handler });
        await expect(c.starter!.start(R, { stateMachineArn: VERSION, name: NAME, input: '{}' })).rejects.toMatchObject({ code: 'aws_caller_unavailable' });
        await expect(c.describer!.describeForEnrollment(R, INSTANCE)).rejects.toMatchObject({ code: 'aws_caller_unavailable' });
        expect(http.requests).toHaveLength(0);
    });

    it('EC2 DescribeInstances goes to the placement region, signed with the assumed key', async () => {
        const http = stubHttp((req) => {
            if (req.hostname.startsWith('sts.')) return { headers: { 'content-type': 'text/xml' }, body: STS_XML };
            if (req.body.includes('Action=DescribeInstances')) {
                return {
                    headers: { 'content-type': 'text/xml' },
                    body: `<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><reservationSet><item><instancesSet><item>
<instanceId>${INSTANCE}</instanceId><instanceState><code>16</code><name>running</name></instanceState>
<placement><availabilityZone>us-east-1a</availabilityZone><availabilityZoneId>use1-az1</availabilityZoneId></placement>
<ipAddress>203.0.113.7</ipAddress><tagSet><item><key>ezil:generation</key><value>2</value></item></tagSet>
<blockDeviceMapping><item><deviceName>/dev/sdf</deviceName><ebs><volumeId>${DATA}</volumeId><deleteOnTermination>false</deleteOnTermination></ebs></item></blockDeviceMapping>
</item></instancesSet></item></reservationSet></DescribeInstancesResponse>`,
                };
            }
            return {
                headers: { 'content-type': 'text/xml' },
                body: `<DescribeVolumesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><volumeSet><item><volumeId>${DATA}</volumeId>
<tagSet><item><key>ezil:disk-kind</key><value>data</value></item></tagSet></item></volumeSet></DescribeVolumesResponse>`,
            };
        });
        const c = createAwsSdkCollaborators(ENV_ON, { token: () => 'oidc', requestHandler: http.handler });
        const view = await c.describer!.describeForEnrollment(R, INSTANCE);
        expect(view).toMatchObject({ state: 'running', availabilityZoneId: 'use1-az1', publicIp: '203.0.113.7', volumes: [{ volumeId: DATA, deleteOnTermination: false, tags: { 'ezil:disk-kind': 'data' } }] });
        const ec2Requests = http.requests.filter((r) => r.hostname.startsWith('ec2.'));
        expect(ec2Requests.map((r) => r.hostname)).toEqual([`ec2.${R}.amazonaws.com`, `ec2.${R}.amazonaws.com`]);
        for (const r of ec2Requests) expect(r.headers.authorization).toContain('Credential=ASIAASSUMEDKEY/');
    });
});
