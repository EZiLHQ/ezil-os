/** Upload-first staging on disposable PostgreSQL with the real 0011 SQL (same harness as ingest.pg.test.ts). */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/server/db/schema';
import { feedbackAdminQueries } from './admin-queries';
import { inspectImage } from './image';
import { deleteFeedback, ingestFeedback, listFeedback, stageFeedbackImage, stagingTicket, type FeedbackDb } from './ingest';
import { runFeedbackRetention } from './retention';
import { FEEDBACK_LIMITS, type FeedbackSubmit } from './types';

const PG = process.env.EZIL_PG_TEST_URL;
const NOW = new Date('2026-10-28T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJx8AAAAASUVORK5CYII=';
/** A distinct valid PNG header per n (its width), so each has its own hash. */
const png = (n: number) => {
    const bytes = Buffer.from(PNG, 'base64');
    bytes.writeUInt32BE(n + 1, 16);
    return inspectImage('image/png', bytes);
};
const refs = (...images: ReturnType<typeof png>[]) => images.map(({ sha256, contentType }) => ({ sha256, contentType }));
const report = (clientRequestId: string, screenshotRefs?: ReturnType<typeof refs>): FeedbackSubmit =>
    ({ v: 1, clientRequestId, category: 'bug', description: '[synthetic] staged upload', ...(screenshotRefs ? { screenshotRefs } : {}) });

describe.skipIf(!PG)('feedback upload-first staging on PostgreSQL', () => {
    const name = `feedback_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const client = PG ? postgres(PG, { max: 8, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    const db = (client ? drizzle(client, { schema }) : null) as unknown as FeedbackDb;
    let created = false;
    const rows = async (reportId: string) => admin!.unsafe(
        `SELECT sha256, created_at FROM ${name}.ezil_feedback_attachments WHERE report_id = $1 ORDER BY created_at, sha256`, [reportId]);
    beforeAll(async () => {
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await admin!.unsafe(`CREATE SCHEMA ${name}`); created = true;
        const sql = readFileSync(path.resolve(__dirname, '../../../drizzle/0011_feedback.sql'), 'utf8');
        await admin!.begin((tx) => tx.unsafe(sql.replaceAll('public.', `${name}.`)));
        await admin!.unsafe(`CREATE TABLE ${name}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz)`);
    });
    afterAll(async () => {
        if (created) await admin!.unsafe(`DROP SCHEMA ${name} CASCADE`);
        await client?.end(); await admin?.end();
    });

    it('stages, stays invisible until finalize, then stores the report with its images in preview order', async () => {
        const user = randomUUID(); const crid = randomUUID(); const ticket = stagingTicket(user, crid);
        const [a, b, c] = [png(2), png(0), png(1)];
        for (const image of [a, b, c]) expect((await stageFeedbackImage(db, user, crid, image, NOW)).status).toBe(201);
        // A retried PUT of the same image reuses its row.
        expect(await stageFeedbackImage(db, user, crid, b, at(10))).toEqual({ status: 200, staged: { sha256: b.sha256, finalized: false } });
        expect(await rows(ticket)).toHaveLength(3);
        const queries = feedbackAdminQueries(drizzle(client!, { schema }));
        expect(await listFeedback(db, user)).toEqual([]);
        expect(await queries.findScreenshot(ticket)).toBeNull();
        expect(await queries.listReports([ticket])).toEqual([]);

        const result = await ingestFeedback(db, user, report(crid, refs(c, a, b)), at(1000));
        expect(result).toEqual({ status: 201, created: { id: ticket, createdAt: at(1000).toISOString(), screenshotAccepted: true, screenshotCount: 3 } });
        for (const [n, image] of [c, a, b].entries()) expect(Buffer.from((await queries.findScreenshot(ticket, n))!.bytes)).toEqual(image.bytes);
        expect((await listFeedback(db, user))[0]).toMatchObject({ id: ticket, hasScreenshot: true, screenshotCount: 3 });
        // The lost-answer retry: finalize again answers the stored report.
        expect(await ingestFeedback(db, user, report(crid, refs(c, a, b)), at(2000))).toEqual({ ...result, status: 200 });
    });

    it('never changes a stored report: a PUT after finalize acknowledges its own image and refuses any other', async () => {
        const user = randomUUID(); const crid = randomUUID(); const ticket = stagingTicket(user, crid);
        await stageFeedbackImage(db, user, crid, png(3), NOW);
        expect((await ingestFeedback(db, user, report(crid, refs(png(3))), at(1))).status).toBe(201);
        expect(await stageFeedbackImage(db, user, crid, png(3), at(2))).toEqual({ status: 200, staged: { sha256: png(3).sha256, finalized: true } });
        expect(await stageFeedbackImage(db, user, crid, png(4), at(3))).toEqual({ status: 409, error: 'report_already_sent' });
        // An inline report is just as closed to staging.
        const inline = randomUUID();
        expect((await ingestFeedback(db, user, report(inline), at(4))).status).toBe(201);
        expect(await stageFeedbackImage(db, user, inline, png(4), at(5))).toEqual({ status: 409, error: 'report_already_sent' });
        expect((await rows(ticket)).map(row => row.sha256)).toEqual([png(3).sha256]);
        expect(await rows(stagingTicket(user, inline))).toHaveLength(0);
    });

    it('all or none: an unknown, foreign or mismatched reference stores nothing and keeps what is staged', async () => {
        const alice = randomUUID(); const bob = randomUUID(); const crid = randomUUID();
        await stageFeedbackImage(db, alice, crid, png(5), NOW);
        await stageFeedbackImage(db, alice, crid, png(6), NOW);
        const missing = { status: 409, error: 'staged_images_missing' };
        // Bob uses Alice's request id and her hashes: his own ticket holds nothing.
        expect(await ingestFeedback(db, bob, report(crid, refs(png(5), png(6))), at(1))).toEqual(missing);
        expect(await ingestFeedback(db, alice, report(crid, refs(png(5), png(7))), at(1))).toEqual(missing);
        expect(await ingestFeedback(db, alice, report(crid, [{ sha256: png(5).sha256, contentType: 'image/webp' }]), at(1))).toEqual(missing);
        expect(await listFeedback(db, alice)).toEqual([]);
        expect(await listFeedback(db, bob)).toEqual([]);
        expect(await rows(stagingTicket(alice, crid))).toHaveLength(2);
        // A frozen report that dropped one staged image keeps only the referenced one.
        expect((await ingestFeedback(db, alice, report(crid, refs(png(6))), at(2))).status).toBe(201);
        expect((await rows(stagingTicket(alice, crid))).map(row => row.sha256)).toEqual([png(6).sha256]);
    });

    it('an expired staging is not finalized, and the offline retry renews it by uploading again', async () => {
        const user = randomUUID(); const crid = randomUUID();
        await stageFeedbackImage(db, user, crid, png(8), NOW);
        const later = at(FEEDBACK_LIMITS.stagedImageFreshMs + 60_000);
        expect(await ingestFeedback(db, user, report(crid, refs(png(8))), later)).toEqual({ status: 409, error: 'staged_images_missing' });
        expect((await stageFeedbackImage(db, user, crid, png(8), later)).status).toBe(201);
        expect(await rows(stagingTicket(user, crid))).toHaveLength(1);
        expect((await ingestFeedback(db, user, report(crid, refs(png(8))), at(FEEDBACK_LIMITS.stagedImageFreshMs + 61_000))).status).toBe(201);
    });

    it('bounds a request to five images and a user to three unsent reports', async () => {
        const user = randomUUID(); const crid = randomUUID();
        for (let n = 0; n < FEEDBACK_LIMITS.imagesMax; n++) expect((await stageFeedbackImage(db, user, crid, png(20 + n), NOW)).status).toBe(201);
        expect(await stageFeedbackImage(db, user, crid, png(30), NOW)).toEqual({ status: 413, error: 'payload_too_large' });
        const tickets = [crid, randomUUID(), randomUUID()];
        for (const ticket of tickets.slice(1)) expect((await stageFeedbackImage(db, user, ticket, png(40), NOW)).status).toBe(201);
        const fourth = randomUUID();
        expect(await stageFeedbackImage(db, user, fourth, png(40), NOW)).toEqual({ status: 429, error: 'staged_reports_limit' });
        // Sending one frees its place.
        expect((await ingestFeedback(db, user, report(tickets[1]!, refs(png(40))), at(1))).status).toBe(201);
        expect((await stageFeedbackImage(db, user, fourth, png(40), at(2))).status).toBe(201);
    });

    it('a ticket older than a day is admitted again only under the three-report cap', async () => {
        const user = randomUUID(); const old = randomUUID();
        await stageFeedbackImage(db, user, old, png(70), NOW);
        const later = at(FEEDBACK_LIMITS.stagedImageTtlMs + 1);
        const fresh = [randomUUID(), randomUUID(), randomUUID()];
        for (const ticket of fresh) expect((await stageFeedbackImage(db, user, ticket, png(71), later)).status).toBe(201);
        // Reactivating the expired ticket (same image, or a new one) would be a fourth unsent report.
        const before = await rows(stagingTicket(user, old));
        const bytes = async () => (await admin!.unsafe(`SELECT coalesce(sum(byte_length), 0)::int AS n FROM ${name}.ezil_feedback_attachments`))[0]?.n;
        const budget = await bytes();
        expect(await stageFeedbackImage(db, user, old, png(70), later)).toEqual({ status: 429, error: 'staged_reports_limit' });
        expect(await stageFeedbackImage(db, user, old, png(72), later)).toEqual({ status: 429, error: 'staged_reports_limit' });
        expect(await rows(stagingTicket(user, old))).toEqual(before);
        expect(await bytes()).toBe(budget);
        // Once one of the three is sent, the old ticket is admitted and renewed in place (one row, now fresh).
        expect((await ingestFeedback(db, user, report(fresh[0]!, refs(png(71))), at(FEEDBACK_LIMITS.stagedImageTtlMs + 2))).status).toBe(201);
        expect((await stageFeedbackImage(db, user, old, png(70), at(FEEDBACK_LIMITS.stagedImageTtlMs + 3))).status).toBe(201);
        expect((await rows(stagingTicket(user, old))).map(row => row.sha256)).toEqual([png(70).sha256]);
    });

    it('concurrent PUTs of one image store one row; a concurrent finalize and PUT never add to the report', async () => {
        const user = randomUUID(); const crid = randomUUID();
        const puts = await Promise.all([0, 1, 2].map(() => stageFeedbackImage(db, user, crid, png(50), NOW)));
        expect(puts.map(r => r.status).sort()).toEqual([200, 200, 201]);
        const [finalized, late] = await Promise.all([
            ingestFeedback(db, user, report(crid, refs(png(50))), at(1)),
            stageFeedbackImage(db, user, crid, png(51), at(1)),
        ]);
        expect(finalized.status).toBe(201);
        // Either the extra image was staged first (then finalize deleted it as unreferenced) or it was refused.
        expect([201, 409]).toContain(late.status);
        expect((await rows(stagingTicket(user, crid))).map(row => row.sha256)).toEqual([png(50).sha256]);
    });

    it('cleanup removes unsent staging after a day and keeps fresh staging and stored reports', async () => {
        const user = randomUUID(); const old = randomUUID(); const fresh = randomUUID(); const sent = randomUUID();
        const dayAgo = at(-FEEDBACK_LIMITS.stagedImageTtlMs - 60_000);
        await stageFeedbackImage(db, user, old, png(60), dayAgo);
        await stageFeedbackImage(db, user, sent, png(61), dayAgo);
        expect((await ingestFeedback(db, user, report(sent, refs(png(61))), at(-FEEDBACK_LIMITS.stagedImageTtlMs))).status).toBe(201);
        await stageFeedbackImage(db, user, fresh, png(62), at(-60_000));
        await runFeedbackRetention(drizzle(client!, { schema }) as never, { now: () => NOW.getTime() });
        expect(await rows(stagingTicket(user, old))).toHaveLength(0);
        expect(await rows(stagingTicket(user, fresh))).toHaveLength(1);
        expect(await rows(stagingTicket(user, sent))).toHaveLength(1);
        // The owner's delete removes a staged-then-sent report with its image.
        expect(await deleteFeedback(db, user, stagingTicket(user, sent))).toBe(true);
        expect(await rows(stagingTicket(user, sent))).toHaveLength(0);
    });
});
