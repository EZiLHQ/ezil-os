/**
 * Codex 4277262199: a StartExecution that got NO ANSWER may have been carried out. Only an
 * answered refusal (or a failure before sending) is a refusal; everything else is unknown.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LifecycleStarter } from './aws-ec2';
import { AwsClientError, isDefiniteAwsRefusal, isExecutionAbsent } from './aws-errors';
import { START_ATTEMPTS, startLifecycleJob } from './aws-receipts';

const sdk = (name: string, status?: number) => Object.assign(new Error(name), { name, ...(status ? { $metadata: { httpStatusCode: status } } : {}) });

describe('isDefiniteAwsRefusal', () => {
    it.each([
        ['an answered 400', sdk('ValidationException', 400)],
        ['an answered 429 throttle (rejected, not run)', sdk('ThrottlingException', 429)],
        ['a named service refusal', sdk('AccessDeniedException')],
        ['a named capacity refusal', sdk('ExecutionLimitExceeded')],
        ['a check before sending', new AwsClientError('aws_config', false, 'StateMachineVersionArnRequired')],
    ])('%s is a refusal', (_n, error) => expect(isDefiniteAwsRefusal(error)).toBe(true));

    it.each([
        ['a 500', sdk('InternalFailure', 500)],
        ['a 503', sdk('ServiceUnavailable', 503)],
        ['a timeout', sdk('TimeoutError')],
        ['a connection reset', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
        ['an abort', sdk('AbortError')],
        ['anything thrown that is not an error', 'boom'],
    ])('%s is unknown, never a refusal', (_n, error) => expect(isDefiniteAwsRefusal(error)).toBe(false));

    it('ExecutionDoesNotExist is recognised', () => {
        expect(isExecutionAbsent(sdk('ExecutionDoesNotExist', 400))).toBe(true);
        expect(isExecutionAbsent(sdk('InternalFailure', 500))).toBe(false);
    });
});

describe('startLifecycleJob', () => {
    const work = { stateMachineArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-lifecycle:1', name: 'computer-x', input: '{}' };
    function starterFailing(errors: unknown[]) {
        const calls: string[] = [];
        const starter: LifecycleStarter = {
            async start(_r, w) {
                calls.push(w.name);
                const e = errors.shift();
                if (e !== undefined) throw e;
            },
        };
        return { starter, calls };
    }

    it('retries a lost answer with backoff, the SAME execution, and reports started when one is accepted', async () => {
        const sleep = vi.fn(async () => {});
        const { starter, calls } = starterFailing([sdk('TimeoutError'), sdk('InternalFailure', 500)]);
        expect(await startLifecycleJob(starter, 'ap-south-1', work, sleep)).toBe('started');
        expect(calls).toEqual(['computer-x', 'computer-x', 'computer-x']);
        expect(sleep.mock.calls).toEqual([[250], [1000]]);
    });

    it('an answered refusal stops at once: refused', async () => {
        const { starter, calls } = starterFailing([sdk('AccessDeniedException', 400)]);
        expect(await startLifecycleJob(starter, 'ap-south-1', work, async () => {})).toBe('refused');
        expect(calls).toHaveLength(1);
    });

    it('no answer on every attempt: unknown, after exactly START_ATTEMPTS tries', async () => {
        const { starter, calls } = starterFailing(Array.from({ length: 10 }, () => sdk('TimeoutError')));
        expect(await startLifecycleJob(starter, 'ap-south-1', work, async () => {})).toBe('unknown');
        expect(calls).toHaveLength(START_ATTEMPTS);
    });
});
