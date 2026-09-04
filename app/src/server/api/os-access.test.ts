/**
 * The EZiL OS access gate.
 *
 * The property under test is the one an access gate exists for: in `invite`
 * mode, NOTHING gets through except an email with a live allow-list row. Every
 * denial below is paired with a positive control on the same lookup — a test
 * that only ever sees `allowed: false` cannot tell a working gate from a
 * function that returns `false` unconditionally.
 *
 * The lookup is a function literal, not a module mock (same discipline as
 * `./bearer-auth.test.ts`), and the real Drizzle adapter is exercised through
 * `drizzle-orm/pg-proxy` so the emitted SQL text is asserted without a
 * Postgres anywhere (same technique as `@/server/telemetry/queries.test.ts`).
 */
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import {
    assertOsAccess,
    normalizeAccessEmail,
    OS_ACCESS_NOT_INVITED,
    OsAccessDeniedError,
    osAccessFor,
    osAccessLookup,
    type OsAccessDb,
    type OsAccessLookup,
    type OsAccessLookupRow,
} from './os-access';

const LIVE: OsAccessLookupRow = { email: 'alice@example.com', revokedAt: null };
const REVOKED: OsAccessLookupRow = { email: 'mallory@example.com', revokedAt: new Date('2026-01-01T00:00:00Z') };

/**
 * An allow-list holding exactly Alice (live) and Mallory (revoked). Records
 * every key it was asked for, so a test can assert the gate normalised before
 * querying rather than inferring it from the answer.
 */
const lookupOf = (...rows: OsAccessLookupRow[]): OsAccessLookup & { asked: string[] } => {
    const asked: string[] = [];
    return {
        asked,
        async findByEmail(email) {
            asked.push(email);
            return rows.find((r) => r.email === email) ?? null;
        },
    };
};

const listing = () => lookupOf(LIVE, REVOKED);

/** A lookup that must never be consulted; calling it fails the test loudly. */
const forbiddenLookup = (): OsAccessLookup => ({
    async findByEmail(email) {
        throw new Error(`the allow-list was queried when it should not have been (for "${email}")`);
    },
});

describe('open mode', () => {
    it('lets anyone in without consulting the allow-list at all', async () => {
        await expect(osAccessFor(forbiddenLookup(), { email: 'nobody@example.com' }, 'open')).resolves.toEqual({
            allowed: true,
            reason: 'open',
        });
    });

    it('lets in an identity carrying no email — open means open', async () => {
        // The one case the two rules could have been read as contradicting.
        // Pinned so neither A2 nor a later edit can drift on it.
        await expect(osAccessFor(forbiddenLookup(), { email: null }, 'open')).resolves.toEqual({
            allowed: true,
            reason: 'open',
        });
        await expect(osAccessFor(forbiddenLookup(), {}, 'open')).resolves.toEqual({
            allowed: true,
            reason: 'open',
        });
    });

    it('lets in a REVOKED email — the allow-list is simply not the gate in this mode', async () => {
        await expect(osAccessFor(listing(), { email: REVOKED.email }, 'open')).resolves.toEqual({
            allowed: true,
            reason: 'open',
        });
    });
});

describe('invite mode — the positive control', () => {
    it('admits an email with a live (unrevoked) row', async () => {
        const lookup = listing();
        await expect(osAccessFor(lookup, { email: 'alice@example.com' }, 'invite')).resolves.toEqual({
            allowed: true,
            reason: 'invited',
        });
        expect(lookup.asked).toEqual(['alice@example.com']);
    });
});

describe('invite mode — every way in is closed', () => {
    // 🔴 Each of these is an account that authenticated successfully. If any
    // returned `allowed: true`, a stranger who can sign up reaches the whole
    // product. The positive control above shares the SAME lookup instance
    // shape, so none of these can pass by the lookup simply being broken.
    it('denies an email with a REVOKED row — and says so, distinctly', async () => {
        await expect(osAccessFor(listing(), { email: REVOKED.email }, 'invite')).resolves.toEqual({
            allowed: false,
            reason: 'revoked',
        });
    });

    it('denies an email with no row at all', async () => {
        await expect(osAccessFor(listing(), { email: 'stranger@example.com' }, 'invite')).resolves.toEqual({
            allowed: false,
            reason: OS_ACCESS_NOT_INVITED,
        });
        expect(OS_ACCESS_NOT_INVITED).toBe('not_invited');
    });

    it('denies an identity with no email, without querying the allow-list for ""', async () => {
        const lookup = listing();
        for (const user of [{ email: null }, { email: undefined }, {}, { email: '' }, { email: '   ' }]) {
            await expect(osAccessFor(lookup, user, 'invite')).resolves.toEqual({
                allowed: false,
                reason: 'no_email',
            });
        }
        // An empty key must never reach storage: a stray `('', ...)` row would
        // otherwise become a skeleton key for every emailless identity.
        expect(lookup.asked).toEqual([]);
    });

    it('denies a null/undefined user outright', async () => {
        await expect(osAccessFor(listing(), null, 'invite')).resolves.toEqual({
            allowed: false,
            reason: 'no_email',
        });
        await expect(osAccessFor(listing(), undefined, 'invite')).resolves.toEqual({
            allowed: false,
            reason: 'no_email',
        });
    });

    it('does NOT swallow a lookup failure into an allow', async () => {
        // 🔴 A gate that opens when its storage is down is not a gate.
        const broken: OsAccessLookup = {
            async findByEmail() {
                throw new Error('connection terminated unexpectedly');
            },
        };
        await expect(osAccessFor(broken, { email: 'alice@example.com' }, 'invite')).rejects.toThrow(
            'connection terminated unexpectedly',
        );
    });
});

describe('email normalisation', () => {
    it.each([
        ['Alice@Example.com', 'upper-cased local and domain'],
        ['ALICE@EXAMPLE.COM', 'shouting'],
        ['  alice@example.com  ', 'pasted with surrounding whitespace'],
        ['\tAlice@Example.COM\n', 'tabs and a newline from a copied cell'],
    ])('admits %j (%s) against the lower-cased row', async (raw) => {
        const lookup = listing();
        await expect(osAccessFor(lookup, { email: raw }, 'invite')).resolves.toEqual({
            allowed: true,
            reason: 'invited',
        });
        expect(lookup.asked).toEqual(['alice@example.com']);
    });

    it('normalises a REVOKED address the same way — case is not an escape hatch', async () => {
        // The mirror image of the test above, and the more important half: if
        // normalisation only ran on the allow path, `MALLORY@EXAMPLE.COM`
        // would miss the revoked row, fall through to "no row", and be denied
        // for the WRONG reason today — and admitted outright the moment the
        // default flipped.
        await expect(osAccessFor(listing(), { email: '  MALLORY@Example.com ' }, 'invite')).resolves.toEqual({
            allowed: false,
            reason: 'revoked',
        });
    });

    it('normalizeAccessEmail is total over null/undefined/blank', () => {
        expect(normalizeAccessEmail(null)).toBe('');
        expect(normalizeAccessEmail(undefined)).toBe('');
        expect(normalizeAccessEmail('   ')).toBe('');
        expect(normalizeAccessEmail(' A@B.C ')).toBe('a@b.c');
    });
});

describe('assertOsAccess — the guard-clause form A2 calls', () => {
    it('returns the allowing result rather than void, so a caller can log open vs invited', async () => {
        await expect(assertOsAccess(listing(), { email: 'alice@example.com' }, 'invite')).resolves.toEqual({
            allowed: true,
            reason: 'invited',
        });
        await expect(assertOsAccess(forbiddenLookup(), { email: 'x@y.z' }, 'open')).resolves.toEqual({
            allowed: true,
            reason: 'open',
        });
    });

    it.each([
        [{ email: 'stranger@example.com' }, OS_ACCESS_NOT_INVITED],
        [{ email: REVOKED.email }, 'revoked'],
        [{ email: null }, 'no_email'],
    ])('throws OsAccessDeniedError carrying reason %#', async (user, reason) => {
        // Asserted on the REASON, not merely "it threw" — A2 maps this field
        // onto the FORBIDDEN message, so a wrong-but-thrown reason would ship.
        await expect(assertOsAccess(listing(), user, 'invite')).rejects.toBeInstanceOf(OsAccessDeniedError);
        await expect(assertOsAccess(listing(), user, 'invite')).rejects.toMatchObject({
            name: 'OsAccessDeniedError',
            reason,
        });
        await expect(assertOsAccess(listing(), user, 'invite')).rejects.toThrow(`EZiL OS access denied: ${reason}`);
    });
});

// ── The real Drizzle adapter ───────────────────────────────────────────────
// Structural tests against the SQL `osAccessLookup` actually builds. These do
// not prove it runs against a live Postgres (there is no server binary here),
// but they do pin the table, the key column, and the ABSENCE of a revoked_at
// predicate — the one thing a hand-written query would most plausibly "fix"
// and thereby destroy the revoked/not-invited distinction.

/**
 * 🔴 Rows are POSITIONAL ARRAYS, in the select's column order — that is what
 * `pg-proxy` hands to Drizzle's own field mappers, and it is why these tests
 * exercise the real mapping rather than a hand-built object. Measured: an
 * object row (`{ email, revokedAt }`) is mapped to `{}`, because Drizzle
 * reads by index. `revoked_at` is therefore given as the wire string a
 * `timestamptz` really arrives as, and Drizzle's mapper is what turns it into
 * a `Date`.
 */
const pgRow = (email: string, revokedAt: string | null) => [email, revokedAt];

function makeTestDb(rows: unknown[] = []) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(
        async (sql, params) => {
            statements.push({ sql, params });
            return { rows };
        },
        { schema },
    ) as unknown as OsAccessDb;
    return { db, statements };
}

describe('osAccessLookup — the ezil_os_access query', () => {
    it('selects email + revoked_at from ezil_os_access, keyed on the email', async () => {
        const { db, statements } = makeTestDb([]);
        await osAccessLookup(db).findByEmail('alice@example.com');

        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/ezil_os_access/);
        expect(statements[0]!.sql).toMatch(/"email"/);
        expect(statements[0]!.sql).toMatch(/"revoked_at"/);
        expect(statements[0]!.params).toContain('alice@example.com');
    });

    it('🔴 does NOT filter revoked_at in SQL — the row must come back so the caller can say "revoked"', async () => {
        const { db, statements } = makeTestDb([]);
        await osAccessLookup(db).findByEmail('mallory@example.com');
        expect(statements[0]!.sql).not.toMatch(/revoked_at["\s]*is\s+null/i);
    });

    it('returns the row the database gave it, revoked flag intact and mapped to a Date', async () => {
        const { db } = makeTestDb([pgRow('mallory@example.com', '2026-01-01 00:00:00+00')]);
        await expect(osAccessLookup(db).findByEmail('mallory@example.com')).resolves.toEqual({
            email: 'mallory@example.com',
            revokedAt: new Date('2026-01-01T00:00:00Z'),
        });
    });

    it('maps a live row to revokedAt === null, not undefined', async () => {
        // The distinction the gate branches on. `undefined` would read as
        // "revoked" (`undefined !== null`) — which fails CLOSED, and is still
        // the wrong answer for a person who is genuinely invited.
        const { db } = makeTestDb([pgRow('alice@example.com', null)]);
        await expect(osAccessLookup(db).findByEmail('alice@example.com')).resolves.toEqual({
            email: 'alice@example.com',
            revokedAt: null,
        });
    });

    it('returns null (not undefined, not a throw) when there is no row', async () => {
        const { db } = makeTestDb([]);
        await expect(osAccessLookup(db).findByEmail('stranger@example.com')).resolves.toBeNull();
    });

    it('END-TO-END over the real query builder: a revoked row denies, a live row admits', async () => {
        const denied = await osAccessFor(
            osAccessLookup(makeTestDb([pgRow('mallory@example.com', '2026-01-01 00:00:00+00')]).db),
            { email: 'Mallory@Example.com' },
            'invite',
        );
        expect(denied).toEqual({ allowed: false, reason: 'revoked' });

        const admitted = await osAccessFor(
            osAccessLookup(makeTestDb([pgRow('alice@example.com', null)]).db),
            { email: 'Alice@Example.com ' },
            'invite',
        );
        expect(admitted).toEqual({ allowed: true, reason: 'invited' });
    });
});

// ── The mode itself ────────────────────────────────────────────────────────
// `osAccessFor` takes the mode as a parameter, which is what keeps it free of
// `@/env` — but that also means nothing above this line proves the DEFAULT is
// the closed one. This block does, by importing `@/env` for real. It is the
// only place in the file that touches `@/env`, and it restores `process.env`
// afterwards.

describe('EZIL_OS_ACCESS_MODE — the default is the closed one', () => {
    /** Loads a fresh `@/env` under a given value for the mode. */
    const modeUnder = async (value: string | undefined): Promise<string> => {
        vi.resetModules();
        const saved = { ...process.env };
        try {
            // The client schema is validated on every path, so these must be
            // present or the import throws for an unrelated reason.
            process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://project.supabase.co';
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key-placeholder';
            process.env.SUPABASE_DATABASE_URL = 'postgresql://placeholder/db';
            if (value === undefined) delete process.env.EZIL_OS_ACCESS_MODE;
            else process.env.EZIL_OS_ACCESS_MODE = value;

            const mod = await import('@/env');
            return mod.env.EZIL_OS_ACCESS_MODE;
        } finally {
            process.env = saved;
        }
    };

    it('🔴 is "invite" when the variable is not set at all', async () => {
        // A deploy that never heard of this variable is invite-only. If this
        // ever reads "open", every environment that has not been updated is
        // wide open and nothing else in this file would notice.
        await expect(modeUnder(undefined)).resolves.toBe('invite');
    });

    it('is "open" only when someone explicitly typed it', async () => {
        await expect(modeUnder('open')).resolves.toBe('open');
    });

    it('is "invite" when explicitly typed', async () => {
        await expect(modeUnder('invite')).resolves.toBe('invite');
    });

    it('refuses a typo at boot rather than silently picking a side', async () => {
        // `opne` must not read as "not open, therefore invite" by accident —
        // the same misconfiguration in the other direction is what a silent
        // fallback would hide.
        await expect(modeUnder('opne')).rejects.toThrow(/Invalid server environment variables/);
    });
});
