import { describe, expect, it } from 'vitest';

import { explainAwsCanary, explainAwsCanaryCohort, type AwsCanaryExplanation } from './placement-explain';

const userId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const otherUserId = 'fedcbafe-dcba-4fed-8cba-fedcbafedcba';
const SINCE = '2026-10-15T13:12:00Z';
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_CANARY_USER_IDS: userId, EZIL_AWS_CANARY_SINCE: SINCE };
const computer = { userId, createdAt: new Date('2026-10-15T13:12:01Z'), deleted: false };
const before = new Date('2026-10-15T13:11:59.999Z');
type Input = Parameters<typeof explainAwsCanary>[0];

describe('explainAwsCanary', () => {
    const reasons: { reason: AwsCanaryExplanation['reason']; input: Input }[] = [
        { reason: 'aws_disabled', input: { env: { ...env, EZIL_AWS_COMPUTERS_ENABLED: '0' }, userId, computer } },
        { reason: 'canary_unset', input: { env: { ...env, EZIL_AWS_CANARY_SINCE: undefined }, userId, computer } },
        { reason: 'canary_malformed', input: { env: { ...env, EZIL_AWS_CANARY_USER_IDS: 'not-a-uuid' }, userId, computer } },
        { reason: 'user_not_in_cohort', input: { env: { ...env, EZIL_AWS_CANARY_USER_IDS: otherUserId }, userId, computer } },
        { reason: 'computer_missing', input: { env, userId, computer: null } },
        { reason: 'computer_deleted', input: { env, userId, computer: { ...computer, deleted: true } } },
        { reason: 'owner_mismatch', input: { env, userId, computer: { ...computer, userId: otherUserId } } },
        { reason: 'created_before_since', input: { env, userId, computer: { ...computer, createdAt: before } } },
        { reason: 'eligible', input: { env, userId, computer } },
    ];

    it.each(reasons)('returns only $reason and its diagnostic fields', ({ reason, input }) => {
        const result = explainAwsCanary(input);
        expect(result).toEqual(reason === 'created_before_since'
            ? { eligible: false, reason, since: '2026-10-15T13:12:00.000Z', createdAt: '2026-10-15T13:11:59.999Z' }
            : { eligible: reason === 'eligible', reason });
        expect(JSON.stringify(result)).not.toContain(userId);
        expect(JSON.stringify(result)).not.toContain(otherUserId);
    });

    it.each([undefined, '', '0', 'true', ' 1', '1 '])('AWS flag %j is disabled', (flag) => {
        expect(explainAwsCanary({ env: { ...env, EZIL_AWS_COMPUTERS_ENABLED: flag }, userId, computer }))
            .toEqual({ eligible: false, reason: 'aws_disabled' });
    });

    it.each(['EZIL_AWS_CANARY_USER_IDS', 'EZIL_AWS_CANARY_SINCE'].flatMap((key) =>
        (key === 'EZIL_AWS_CANARY_USER_IDS' ? ['', ' \t\n '] : [undefined, '', ' \t\n ']).map((value) => ({ key, value })),
    ))('$key = $value is unset', ({ key, value }) => {
        expect(explainAwsCanary({ env: { ...env, [key]: value }, userId, computer }))
            .toEqual({ eligible: false, reason: 'canary_unset' });
    });

    it.each([
        { name: 'uppercase cohort ids', list: userId.toUpperCase(), caller: userId },
        { name: 'uppercase caller id', list: userId, caller: userId.toUpperCase() },
        { name: 'uppercase cohort and caller ids', list: userId.toUpperCase(), caller: userId.toUpperCase() },
        { name: 'whitespace around list entries', list: ` \t${otherUserId}, \n${userId} \t`, caller: userId },
        { name: 'wildcard alone includes an unlisted caller', list: '*', caller: otherUserId },
        { name: 'whitespace around wildcard', list: ' \t*\n ', caller: otherUserId },
    ])('$name is eligible', ({ list, caller }) => {
        expect(explainAwsCanary({
            env: { ...env, EZIL_AWS_CANARY_USER_IDS: list }, userId: caller,
            computer: { ...computer, userId: caller.toLowerCase() },
        })).toEqual({ eligible: true, reason: 'eligible' });
    });

    it.each([`${userId},not-a-uuid`, `${userId},`, `,${userId}`, `${userId},,${otherUserId}`, `*,${userId}`, `${userId},*`, ' * , * '])(
        'list %j is malformed as a whole', (list) => {
            expect(explainAwsCanary({ env: { ...env, EZIL_AWS_CANARY_USER_IDS: list }, userId, computer }))
                .toEqual({ eligible: false, reason: 'canary_malformed' });
        },
    );

    it.each(['2026-10-15T13:12:00', '2026-10-15', 'yesterday', '2026-13-40T00:00:00Z'])('SINCE %j is malformed', (since) => {
        expect(explainAwsCanary({ env: { ...env, EZIL_AWS_CANARY_SINCE: since }, userId, computer }))
            .toEqual({ eligible: false, reason: 'canary_malformed' });
    });

    it.each([
        { name: 'exactly SINCE', createdAt: SINCE, expected: { eligible: true, reason: 'eligible' } },
        { name: 'one millisecond before SINCE', createdAt: '2026-10-15T13:11:59.999Z', expected: {
            eligible: false, reason: 'created_before_since', since: '2026-10-15T13:12:00.000Z', createdAt: '2026-10-15T13:11:59.999Z',
        } },
        { name: 'founder computer from September 18', createdAt: '2026-09-18T02:27:45Z', expected: {
            eligible: false, reason: 'created_before_since', since: '2026-10-15T13:12:00.000Z', createdAt: '2026-09-18T02:27:45.000Z',
        } },
    ])('$name', ({ createdAt, expected }) => {
        expect(explainAwsCanary({ env, userId, computer: { ...computer, createdAt: new Date(createdAt) } })).toEqual(expected);
    });

    it.each(['2026-10-15T18:42:00+05:30', '2026-10-15T09:12:00-04:00', ' \t2026-10-15T13:12:00Z\n '])(
        'normalizes SINCE %j to ISO UTC in the cutoff diagnostic', (since) => {
            expect(explainAwsCanary({ env: { ...env, EZIL_AWS_CANARY_SINCE: since }, userId, computer: { ...computer, createdAt: before } }))
                .toEqual({ eligible: false, reason: 'created_before_since', since: '2026-10-15T13:12:00.000Z', createdAt: '2026-10-15T13:11:59.999Z' });
        },
    );

    const precedence: { name: string; input: Input; reason: AwsCanaryExplanation['reason'] }[] = [
        { name: 'disabled before missing config and computer', input: { env: {}, userId, computer: null }, reason: 'aws_disabled' },
        { name: 'unset SINCE before malformed list', input: { env: { ...env, EZIL_AWS_CANARY_USER_IDS: 'bad', EZIL_AWS_CANARY_SINCE: ' ' }, userId, computer: null }, reason: 'canary_unset' },
        { name: 'unset list before malformed SINCE', input: { env: { ...env, EZIL_AWS_CANARY_USER_IDS: ' ', EZIL_AWS_CANARY_SINCE: 'bad' }, userId, computer: null }, reason: 'canary_unset' },
        { name: 'malformed before unlisted user and missing computer', input: { env: { ...env, EZIL_AWS_CANARY_USER_IDS: `${otherUserId},bad` }, userId, computer: null }, reason: 'canary_malformed' },
        { name: 'unlisted user before missing computer', input: { env: { ...env, EZIL_AWS_CANARY_USER_IDS: otherUserId }, userId, computer: null }, reason: 'user_not_in_cohort' },
        { name: 'deleted before wrong owner and old computer', input: { env, userId, computer: { userId: otherUserId, deleted: true, createdAt: before } }, reason: 'computer_deleted' },
        { name: 'wrong owner before old computer', input: { env, userId, computer: { userId: otherUserId, deleted: false, createdAt: before } }, reason: 'owner_mismatch' },
    ];

    it.each(precedence)('reports the first failure: $name', ({ input, reason }) => {
        expect(explainAwsCanary(input)).toEqual({ eligible: false, reason });
    });

    it('does not evaluate admission settings or mutate its inputs', () => {
        const frozenEnv = Object.freeze({ ...env, EZIL_AWS_KILL_SWITCH: '1', AWS_MAX_RUNNING: '0' });
        const frozenComputer = Object.freeze({ ...computer, createdAt: new Date(computer.createdAt) });
        const input = Object.freeze({ env: frozenEnv, userId, computer: frozenComputer });
        const snapshot = JSON.stringify(input);
        expect(explainAwsCanary(input)).toEqual({ eligible: true, reason: 'eligible' });
        expect(JSON.stringify(input)).toBe(snapshot);
    });
});

describe('explainAwsCanaryCohort (no database read)', () => {
    const SINCE = '2026-10-15T13:12:00Z';
    const listed = '11111111-1111-4111-8111-111111111111';
    it.each([
        { env: {}, reason: 'aws_disabled' },
        { env: { EZIL_AWS_COMPUTERS_ENABLED: '1' }, reason: 'canary_unset' },
        { env: { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_CANARY_USER_IDS: `${listed},`, EZIL_AWS_CANARY_SINCE: SINCE }, reason: 'canary_malformed' },
        { env: { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_CANARY_USER_IDS: '44444444-4444-4444-8444-444444444444', EZIL_AWS_CANARY_SINCE: SINCE }, reason: 'user_not_in_cohort' },
    ])('$reason', ({ env, reason }) => {
        expect(explainAwsCanaryCohort({ env, userId: listed })).toEqual({ eligible: false, reason });
    });
    it('passes a listed user, case-insensitively', () => {
        const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_CANARY_USER_IDS: listed.toUpperCase(), EZIL_AWS_CANARY_SINCE: SINCE };
        expect(explainAwsCanaryCohort({ env, userId: listed })).toBeNull();
    });
});
