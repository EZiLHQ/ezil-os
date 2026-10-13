/**
 * aws-ec2 provider STUB (docs/AWS-COMPUTERS.md C-1). No AWS SDK, no network.
 *
 * Every operation refuses with `aws_disabled` unless
 * `EZIL_AWS_COMPUTERS_ENABLED=1`; with the flag on it throws
 * `AwsProviderNotImplementedError`, so nothing can mistake the stub for a
 * working provider. The flag is read at call time.
 */

import { isAwsComputersEnabled, type Env } from './aws-config';
import type { ComputeProvider } from './provider';

export const AWS_DISABLED = 'aws_disabled';

export class AwsProviderNotImplementedError extends Error {
    constructor(operation: string) {
        super(`aws-ec2 provider is not implemented: ${operation}`);
        this.name = 'AwsProviderNotImplementedError';
    }
}

export function createAwsEc2StubProvider(readEnv: () => Env = () => process.env): ComputeProvider {
    const gate = (operation: string): void => {
        if (isAwsComputersEnabled(readEnv())) throw new AwsProviderNotImplementedError(operation);
    };
    return {
        kind: 'aws-ec2',
        ensure: async () => {
            gate('ensure');
            return { ok: false, error: AWS_DISABLED, errorCode: AWS_DISABLED, retryable: false };
        },
        status: async () => {
            gate('status');
            return { ok: false, error: AWS_DISABLED };
        },
        activity: async () => {
            gate('activity');
            return { ok: false, error: AWS_DISABLED };
        },
        restart: async () => {
            gate('restart');
            return { ok: false, outcome: AWS_DISABLED, error: AWS_DISABLED };
        },
        stop: async () => {
            gate('stop');
            return { ok: false, terminated: false, outcome: AWS_DISABLED, error: AWS_DISABLED };
        },
        terminate: async () => {
            gate('terminate');
            return { ok: false, terminated: false, outcome: AWS_DISABLED, error: AWS_DISABLED };
        },
    };
}

export const awsEc2StubProvider: ComputeProvider = createAwsEc2StubProvider();
