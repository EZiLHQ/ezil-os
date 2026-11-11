/**
 * migrations/sponsor/0001_sponsor_attribution.sql against a real, DISPOSABLE Postgres (`app/scripts/billing-test-db.sh up`, which applies
 * the ordered journal including 0021). The sponsor file is applied here once, by hand, because it is deliberately not in the journal.
 * Every statement below runs in its own transaction that is rolled back. Skipped without BILLING_TEST_DATABASE_URL.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { bootstrapSponsorFixture } from './sponsor-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

class Rollback extends Error {}
const HASH = 'a'.repeat(64);

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('sponsor attribution schema (separate, unjournaled)', () => {
    let client: ReturnType<typeof postgres>;
    beforeAll(async () => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 4, prepare: false, onnotice: () => undefined });
        await bootstrapSponsorFixture(process.env.BILLING_TEST_DATABASE_URL!);
    });
    afterAll(async () => { await client.end(); });

    /** Run `fn` in a transaction that is always rolled back; resolve with what it returned. */
    const inTx = async <T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> => {
        let out: T | undefined;
        await client.begin(async tx => { out = await fn(tx); throw new Rollback(); }).catch(error => { if (!(error instanceof Rollback)) throw error; });
        return out as T;
    };
    const failure = async (fn: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<string> => {
        try { await inTx(fn); } catch (error) { return (error as { code?: string }).code ?? 'unknown'; }
        return 'no_error';
    };
    const attribute = (tx: postgres.TransactionSql, key = randomUUID(), campaign = 'test-campaign-a') =>
        tx`insert into ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256) values (${key}, ${campaign}, 'test-partner-a', ${HASH}) returning account_key`;
    const trial = async (tx: postgres.TransactionSql) => {
        const id = randomUUID();
        await tx`insert into ezil_billing_trials (id, user_id, auth_subject, email_normalized, sku, policy_version, quoted_at, trial_end, return_origin)
            values (${id}, null, ${`auth0:${id}`}, ${`${id}@example.invalid`}, 'standard_monthly_v3', 1, now(), now() + interval '1 month', 'https://os-staging.ezil.work')`;
        return id;
    };
    const claim = (tx: postgres.TransactionSql, trialId: string, key: string, campaign = 'test-campaign-a', extra = '') =>
        tx.unsafe(`insert into ezil_sponsor_trial_claims (trial_id, account_key, campaign_id, partner_id, config_sha256, quoted_at ${extra ? ', ' + extra.split('|')[0] : ''})
            values ('${trialId}', '${key}', '${campaign}', 'test-partner-a', '${HASH}', now() ${extra ? ', ' + extra.split('|')[1] : ''})`);

    it('keeps the first attribution and never overwrites it; signed_up_at is set once; nothing is deleted', async () => {
        await inTx(async tx => {
            const [{ account_key: key }] = await attribute(tx);
            await tx`insert into ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256) values (${key}, 'test-campaign-b', 'test-partner-b', ${HASH}) on conflict (account_key) do nothing`;
            const rows = await tx`select campaign_id, signed_up_at from ezil_sponsor_attributions where account_key = ${key}`;
            expect(rows).toHaveLength(1); expect(rows[0]!.campaign_id).toBe('test-campaign-a'); expect(rows[0]!.signed_up_at).toBeNull();
        });
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await tx`insert into ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256) values (${key}, 'test-campaign-b', 'test-partner-b', ${HASH})`; })).toBe('23505');
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await tx`update ezil_sponsor_attributions set campaign_id = 'test-campaign-b' where account_key = ${key}`; })).toBe('23000');
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await tx`update ezil_sponsor_attributions set config_sha256 = ${'b'.repeat(64)} where account_key = ${key}`; })).toBe('23000');
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await tx`delete from ezil_sponsor_attributions where account_key = ${key}`; })).toBe('23000');
        await inTx(async tx => { const [{ account_key: key }] = await attribute(tx); await tx`update ezil_sponsor_attributions set signed_up_at = now() where account_key = ${key}`; });
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await tx`update ezil_sponsor_attributions set signed_up_at = now() where account_key = ${key}`; await tx`update ezil_sponsor_attributions set signed_up_at = now() + interval '1 day' where account_key = ${key}`; })).toBe('23000');
        expect(await failure(tx => tx`insert into ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256) values (${randomUUID()}, 'Bad Campaign', 'test-partner-a', ${HASH})`)).toBe('23514');
        expect(await failure(tx => tx`insert into ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256) values (${randomUUID()}, 'test-campaign-a', 'test-partner-a', 'xyz')`)).toBe('23514');
    });

    it('links a trial only to its own attribution, claims once with a subscription, and is then permanent', async () => {
        expect(await failure(async tx => { await claim(tx, await trial(tx), randomUUID()); })).toBe('23503');                                  // no attribution
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await claim(tx, await trial(tx), key, 'test-campaign-b'); })).toBe('23503');   // another campaign
        await inTx(async tx => { const [{ account_key: key }] = await attribute(tx); const id = await trial(tx); await claim(tx, id, key); });
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await claim(tx, await trial(tx), key, 'test-campaign-a', 'claimed_at|now()'); })).toBe('23514');   // claimed without a subscription
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await claim(tx, await trial(tx), key, 'test-campaign-a', "stripe_subscription_id|'sub_X1'"); })).toBe('23514');   // subscription without claimed_at
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await claim(tx, await trial(tx), key, 'test-campaign-a', "claimed_at, stripe_subscription_id|now() - interval '1 hour', 'sub_X1'"); })).toBe('23514');   // claimed before quoted
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await claim(tx, await trial(tx), key, 'test-campaign-a', "claimed_at, stripe_subscription_id|now(), 'not-a-sub'"); })).toBe('23514');
        expect(await failure(async tx => {
            const [{ account_key: key }] = await attribute(tx); const a = await trial(tx), b = await trial(tx);
            await claim(tx, a, key, 'test-campaign-a', "claimed_at, stripe_subscription_id|now(), 'sub_DUP1'");
            await claim(tx, b, key, 'test-campaign-a', "claimed_at, stripe_subscription_id|now(), 'sub_DUP1'");
        })).toBe('23505');                                                                                                                   // one subscription, one claim
        // claim the quote: set claimed_at and the subscription together, once
        await inTx(async tx => { const [{ account_key: key }] = await attribute(tx); const id = await trial(tx); await claim(tx, id, key);
            await tx`update ezil_sponsor_trial_claims set claimed_at = now() + interval '1 second', stripe_subscription_id = 'sub_OK1' where trial_id = ${id}`; });
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); const id = await trial(tx); await claim(tx, id, key);
            await tx`update ezil_sponsor_trial_claims set claimed_at = now() + interval '1 second', stripe_subscription_id = 'sub_OK2' where trial_id = ${id}`;
            await tx`update ezil_sponsor_trial_claims set stripe_subscription_id = 'sub_OK3' where trial_id = ${id}`; })).toBe('23000');            // consumed: immutable
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); const id = await trial(tx); await claim(tx, id, key);
            await tx`update ezil_sponsor_trial_claims set claimed_at = now() + interval '1 second', stripe_subscription_id = 'sub_OK4' where trial_id = ${id}`;
            await tx`delete from ezil_sponsor_trial_claims where trial_id = ${id}`; })).toBe('23000');                                       // consumed: never deleted
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); const id = await trial(tx); await claim(tx, id, key);
            await tx`update ezil_sponsor_trial_claims set claimed_at = now() + interval '1 second', stripe_subscription_id = 'sub_OK5' where trial_id = ${id}`;
            await tx`delete from ezil_billing_trials where id = ${id}`; })).toBe('23000');                                                    // not even by deleting the trial row
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); const id = await trial(tx); await claim(tx, id, key);
            await tx`update ezil_sponsor_trial_claims set campaign_id = 'test-campaign-b' where trial_id = ${id}`; })).toBe('23000');            // an unclaimed linkage cannot change campaign either
        expect(await failure(async tx => { const [{ account_key: key }] = await attribute(tx); await tx`delete from ezil_sponsor_attributions where account_key = ${key}`; })).toBe('23000');
    });

    it('lets a never-started quote be reclaimed (cascade) and a re-quote move only quoted_at', async () => {
        await inTx(async tx => {
            const [{ account_key: key }] = await attribute(tx); const id = await trial(tx); await claim(tx, id, key);
            await tx`update ezil_sponsor_trial_claims set quoted_at = now() + interval '5 minutes' where trial_id = ${id}`;
            await tx`delete from ezil_billing_trials where id = ${id}`;
            expect(await tx`select 1 from ezil_sponsor_trial_claims where trial_id = ${id}`).toHaveLength(0);
            expect(await tx`select 1 from ezil_sponsor_attributions where account_key = ${key}`).toHaveLength(1);   // attribution survives
        });
    });

    it('counts distinct claimed trials, not abandoned quotes, and is service-only', async () => {
        await inTx(async tx => {
            const [{ account_key: key }] = await attribute(tx); const a = await trial(tx), b = await trial(tx);
            await claim(tx, a, key); await claim(tx, b, key);
            await tx`update ezil_sponsor_trial_claims set claimed_at = now() + interval '1 second', stripe_subscription_id = 'sub_CNT1' where trial_id = ${a}`;
            const [counts] = await tx`select count(*) filter (where claimed_at is not null)::int as claimed, count(*)::int as quoted from ezil_sponsor_trial_claims where account_key = ${key}`;
            expect(counts).toEqual({ claimed: 1, quoted: 2 });
        });
        const [flags] = await client`select c1.relrowsecurity as a, c2.relrowsecurity as b,
            has_table_privilege('anon', 'ezil_sponsor_attributions', 'select') as anon_a, has_table_privilege('authenticated', 'ezil_sponsor_trial_claims', 'select') as auth_b,
            has_table_privilege('public', 'ezil_sponsor_attributions', 'select') as public_a
            from pg_class c1, pg_class c2 where c1.oid = 'ezil_sponsor_attributions'::regclass and c2.oid = 'ezil_sponsor_trial_claims'::regclass`;
        expect(flags).toEqual({ a: true, b: true, anon_a: false, auth_b: false, public_a: false });
    });
});
