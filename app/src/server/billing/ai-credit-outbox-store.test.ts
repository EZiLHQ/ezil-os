import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({
    adminClient: vi.fn(), getUserById: vi.fn(), updateUserById: vi.fn(), enroll: vi.fn(), configured: vi.fn(),
}));
vi.mock('@/server/auth/supabase-admin', () => ({ createAdminClient: stub.adminClient }));
vi.mock('@/server/auth/ai-enrollment', async () => {
    const refusals = ['user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned', 'user_deleted', 'anonymous_user', 'public_id_collision',
        'invalid_identity', 'source_conflict'];
    return {
        enrollAiMember: stub.enroll, aiEnrollmentConfigured: stub.configured,
        isAiEnrollRefusal: (code: string) => refusals.includes(code) || code === 'unknown_refusal',
    };
});

import { createAiCreditOutboxStore, enrollWithStoredSubject } from './ai-credit-outbox-store';

const userId = '3f2f95a1-5420-4a63-94f9-79b85a1ceeb4';
const linked = { id: userId, email_confirmed_at: '2026-10-01T00:00:00Z', app_metadata: { auth0_sub: 'auth0|stored' } };

beforeEach(() => {
    vi.resetAllMocks();
    stub.adminClient.mockReturnValue({ auth: { admin: { getUserById: stub.getUserById, updateUserById: stub.updateUserById } } });
    stub.updateUserById.mockResolvedValue({ data: { user: linked }, error: null });
    stub.configured.mockReturnValue(true);
    stub.getUserById.mockResolvedValue({ data: { user: linked }, error: null });
    stub.enroll.mockResolvedValue({ ok: true });
});
afterEach(() => { vi.useRealTimers(); });

describe('round 5 D1: drain enrollment with the stored EZiL ID subject', () => {
    it('is the store\'s enrollFor', () => {
        const store = createAiCreditOutboxStore({} as Parameters<typeof createAiCreditOutboxStore>[0]);
        expect(typeof store.enrollFor).toBe('function');
    });
    it('enrolls with the stored auth0_sub from the outbox source', async () => {
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('enrolled');
        expect(stub.getUserById).toHaveBeenCalledExactlyOnceWith(userId);
        expect(stub.enroll).toHaveBeenCalledExactlyOnceWith(userId, 'auth0|stored', 'outbox');
    });
    it.each([{}, { auth0_sub: '' }, { auth0_sub: null }, { auth0_sub: 42 }, undefined])
    ('returns needs_ezil_id without a DB client when app_metadata is %j', async metadata => {
        stub.getUserById.mockResolvedValue({ data: { user: { ...linked, app_metadata: metadata } }, error: null });
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('needs_ezil_id');
        expect(stub.enroll).not.toHaveBeenCalled();
    });
    // Review fix (r5 L1, founder-outcome major): a stored subject was linked only by the bridge after
    // Auth0 verified this email, so the drain confirms the Supabase copy (as the bridge does) instead of
    // leaving the account 'activating' forever with refused:email_unconfirmed.
    it.each([undefined, null])('confirms an unconfirmed email (%s) of a linked account, then enrolls', async confirmedAt => {
        stub.getUserById.mockResolvedValue({ data: { user: { ...linked, email_confirmed_at: confirmedAt } }, error: null });
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('enrolled');
        expect(stub.updateUserById).toHaveBeenCalledExactlyOnceWith(userId, { email_confirm: true });
        expect(stub.updateUserById.mock.invocationCallOrder[0]).toBeLessThan(stub.enroll.mock.invocationCallOrder[0]);
        expect(stub.enroll).toHaveBeenCalledExactlyOnceWith(userId, 'auth0|stored', 'outbox');
    });
    it('never confirms the email of an account without a stored subject or an already confirmed one', async () => {
        stub.getUserById.mockResolvedValue({ data: { user: { ...linked, email_confirmed_at: null, app_metadata: {} } }, error: null });
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('needs_ezil_id');
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('needs_ezil_id');
        stub.getUserById.mockResolvedValue({ data: { user: linked }, error: null });
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('enrolled');
        expect(stub.updateUserById).not.toHaveBeenCalled();
    });
    it.each([
        ['error', () => stub.updateUserById.mockResolvedValue({ data: { user: null }, error: { status: 500, message: 'private' } })],
        ['throw', () => stub.updateUserById.mockRejectedValue(new Error('https://private.supabase.co token'))],
    ] as const)('maps a confirm %s to unavailable:connect_failed without enrolling', async (_name, arrange) => {
        stub.getUserById.mockResolvedValue({ data: { user: { ...linked, email_confirmed_at: null } }, error: null });
        arrange();
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('unavailable:connect_failed');
        expect(stub.enroll).not.toHaveBeenCalled();
    });
    it('shares one two-second admin window between the read and the confirm', async () => {
        vi.useFakeTimers();
        stub.getUserById.mockImplementation(() => new Promise(resolve => setTimeout(() =>
            resolve({ data: { user: { ...linked, email_confirmed_at: null } }, error: null }), 1_500)));
        stub.updateUserById.mockReturnValue(new Promise(() => {}));
        let settled = false;
        const result = enrollWithStoredSubject(userId).then(value => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe('unavailable:timeout');
        expect(stub.enroll).not.toHaveBeenCalled();
    });
    it('returns unavailable:disabled with no admin read while enrollment is not configured', async () => {
        stub.configured.mockReturnValue(false);
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('unavailable:disabled');
        expect(stub.adminClient).not.toHaveBeenCalled();
    });
    it.each([
        [{ ok: false, code: 'subject_mismatch' }, 'refused:subject_mismatch'],
        [{ ok: false, code: 'unknown_refusal' }, 'refused:unknown_refusal'],
        [{ ok: false, code: 'probe_failed' }, 'unavailable:probe_failed'],
        [{ ok: false, code: 'timeout' }, 'unavailable:timeout'],
    ] as const)('maps %j to %s', async (result, expected) => {
        stub.enroll.mockResolvedValue(result);
        await expect(enrollWithStoredSubject(userId)).resolves.toBe(expected);
    });
    it.each([
        ['404', { data: { user: null }, error: { status: 404, message: 'private' } }, 'refused:user_not_found'],
        ['500', { data: { user: null }, error: { status: 500, message: 'private' } }, 'unavailable:connect_failed'],
        ['no user', { data: { user: null }, error: null }, 'refused:user_not_found'],
    ] as const)('maps an admin read failure: %s', async (_name, response, expected) => {
        stub.getUserById.mockResolvedValue(response);
        await expect(enrollWithStoredSubject(userId)).resolves.toBe(expected);
        expect(stub.enroll).not.toHaveBeenCalled();
    });
    it('maps a thrown admin read or missing admin env to a fixed code', async () => {
        stub.getUserById.mockRejectedValue(new Error('https://private.supabase.co token'));
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('unavailable:connect_failed');
        stub.adminClient.mockImplementation(() => { throw new Error('session_failed'); });
        await expect(enrollWithStoredSubject(userId)).resolves.toBe('unavailable:connect_failed');
    });
    it('bounds the admin read at two seconds', async () => {
        vi.useFakeTimers();
        stub.getUserById.mockReturnValue(new Promise(() => {}));
        let settled = false;
        const result = enrollWithStoredSubject(userId).then(value => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(1_999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(result).resolves.toBe('unavailable:timeout');
        expect(stub.enroll).not.toHaveBeenCalled();
    });
});
