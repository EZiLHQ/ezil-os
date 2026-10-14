/**
 * AWS failure classification, SDK-free so the lifecycle modules (aws-ec2.ts,
 * aws-receipts.ts) can classify a failed call without importing the AWS SDK.
 * aws-clients.ts re-exports everything here.
 */

// ── Errors ───────────────────────────────────────────────────────────────

export type AwsClientErrorCode =
    | 'aws_caller_unavailable' // no OIDC token, or STS refused/returned no credentials
    | 'aws_throttled' // retry later
    | 'aws_capacity' // a capacity or quota refusal
    | 'aws_config' // access denied, wrong ARN/region/account, missing role setting
    | 'aws_error'; // anything else

/**
 * A machine-readable AWS failure. `awsName` is the SDK exception name, when there was one.
 *
 * `definite`: AWS (or a check before sending) REFUSED the request, so it did nothing —
 * a 4xx answer, a named service refusal, or a failure before anything was sent. Not
 * definite (5xx, timeout, connection reset, abort): the request may have been carried
 * out and only its answer lost. A non-idempotent caller must not treat that as a refusal.
 */
export class AwsClientError extends Error {
    constructor(
        readonly code: AwsClientErrorCode,
        readonly retryable: boolean,
        readonly awsName?: string,
        readonly definite: boolean = true,
    ) {
        super(awsName ? `${code}:${awsName}` : code);
        this.name = 'AwsClientError';
    }
}

const THROTTLED = new Set([
    'ThrottlingException', 'Throttling', 'TooManyRequestsException', 'RequestLimitExceeded', 'RequestThrottled',
    'RequestThrottledException', 'SlowDown', 'ServiceUnavailable', 'ServiceUnavailableException', 'InternalFailure',
    'InternalServerError', 'InternalError', 'IDPCommunicationError',
]);
const CAPACITY = new Set([
    'InsufficientInstanceCapacity', 'VcpuLimitExceeded', 'InstanceLimitExceeded', 'InsufficientVolumeCapacity',
    'VolumeLimitExceeded', 'MaxIOPSLimitExceeded', 'ExecutionLimitExceeded', 'ServiceQuotaExceededException',
]);
const CONFIG = new Set([
    'AccessDenied', 'AccessDeniedException', 'UnauthorizedOperation', 'UnrecognizedClientException', 'AuthFailure',
    'InvalidClientTokenId', 'StateMachineDoesNotExist', 'StateMachineDeleting', 'InvalidArn', 'InvalidName',
    'InvalidExecutionInput', 'InvalidParameterValue', 'InvalidParameterCombination', 'MalformedPolicyDocument',
    'ExecutionDoesNotExist',
]);
const CALLER = new Set(['InvalidIdentityToken', 'IDPRejectedClaim', 'ExpiredTokenException', 'ExpiredToken', 'PackedPolicyTooLarge', 'RegionDisabledException']);

/** Any thrown value → an `AwsClientError`. Never echoes AWS messages (they can name resources). */
export function toAwsClientError(error: unknown): AwsClientError {
    if (error instanceof AwsClientError) return error;
    const e = (error ?? {}) as { name?: unknown; $retryable?: unknown; $metadata?: { httpStatusCode?: number } };
    const name = typeof e.name === 'string' && /^[A-Za-z0-9.]{1,80}$/.test(e.name) ? e.name : undefined;
    if (name && CAPACITY.has(name)) return new AwsClientError('aws_capacity', false, name);
    if (name && CALLER.has(name)) return new AwsClientError('aws_caller_unavailable', false, name);
    if (name && CONFIG.has(name)) return new AwsClientError('aws_config', false, name);
    const status = e.$metadata?.httpStatusCode;
    // Only an answered 4xx is a known refusal; no answer (network, timeout) or a 5xx is unknown.
    const definite = typeof status === 'number' && status >= 400 && status < 500;
    if ((name && THROTTLED.has(name)) || e.$retryable || status === 429 || (typeof status === 'number' && status >= 500)) {
        return new AwsClientError('aws_throttled', true, name, definite);
    }
    return new AwsClientError('aws_error', false, name, definite);
}

/**
 * Whether a failed call is KNOWN not to have been carried out (`AwsClientError.definite`).
 * Any other thrown value is classified first, so an SDK error shaped like a 4xx counts and a
 * bare network error does not.
 */
export function isDefiniteAwsRefusal(error: unknown): boolean {
    return toAwsClientError(error).definite;
}

/** `DescribeExecution` answered that no execution has that name. */
export function isExecutionAbsent(error: unknown): boolean {
    return toAwsClientError(error).awsName === 'ExecutionDoesNotExist';
}
