import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
import { ensureMcpAuth0Account, withBrowserAuth0AccountLock } from './auth0-account';

const identity = { sub: 'auth0|person', email: 'Person@example.test' };
const linked = { id: 'owned', linked: true, sameEmail: true, active: true };
const fixture = (before: unknown[], after = before) => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    const database = { transaction: async <T>(work: (tx: never) => Promise<T>) => work({ execute } as never) };
    const createUser = vi.fn().mockResolvedValue({ data: { user: { id: 'new' } }, error: null });
    return { database, admin: { createUser } as unknown as Parameters<typeof ensureMcpAuth0Account>[1], createUser };
};

describe('MCP account ownership', () => {
    it('reuses only one active subject link, including after a verified email change', async () => {
        const f = fixture([{ ...linked, sameEmail: false }]);
        await ensureMcpAuth0Account(f.database, f.admin, identity);
        expect(f.createUser).not.toHaveBeenCalled();
    });

    it.each([
        [{ ...linked, linked: false }], [{ ...linked, active: false }], [linked, { ...linked, id: 'duplicate' }],
    ])('refuses an email-only, disabled or ambiguous account', async (...rows) => {
        const f = fixture(rows);
        await expect(ensureMcpAuth0Account(f.database, f.admin, identity)).rejects.toMatchObject({ code: 'account_conflict' });
        expect(f.createUser).not.toHaveBeenCalled();
    });

    it('requires a durable exact link after creation, including a lost provider response', async () => {
        const f = fixture([], [linked]);
        f.createUser.mockRejectedValueOnce(new Error('response lost'));
        await ensureMcpAuth0Account(f.database, f.admin, identity);
        expect(f.createUser).toHaveBeenCalledWith({ email: 'person@example.test', email_confirm: true, app_metadata: { auth0_sub: identity.sub } });
        const absent = fixture([]);
        await expect(ensureMcpAuth0Account(absent.database, absent.admin, identity)).rejects.toMatchObject({ code: 'session_failed' });
    });

    it('prevents browser sign-in creating a second identity after the MCP account email changes', async () => {
        const f = fixture([{ ...linked, sameEmail: false }]);
        const resolve = vi.fn();
        await expect(withBrowserAuth0AccountLock(f.database, identity, resolve)).rejects.toMatchObject({ code: 'account_conflict' });
        expect(resolve).not.toHaveBeenCalled();
    });
});
