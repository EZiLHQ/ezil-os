import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { newReservedImageJob, parseImageJobRow, validateImageJob } from './aws-rebase-store';
import { RebaseTime } from './aws-rebase-json';
import { rebaseSetup } from './aws-rebase.test-support';

const preparation = fixtureRebasePreparation();
const reserved = () => newReservedImageJob({ preparation, ownerUserId: '33333333-3333-4333-8333-333333333333',
    sourceRelease: fixtureRebaseRelease(preparation.intent.sourceDeployment), targetRelease: fixtureRebaseRelease(preparation.intent.deployment) });
const finished = () => validateImageJob({ ...reserved(), phase: 'cancelled', updatedAt: '2026-10-22T19:28:51.068Z',
    reconciledAt: '2026-10-22T19:28:50.067Z', completedAt: '2026-10-22T19:28:51.068Z', retainUntil: '2026-10-29T19:28:51.068Z' });
const timestamps = ['createdAt', 'updatedAt', 'reconciledAt', 'completedAt', 'retainUntil'] as const;
const column = (key: string) => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const rowOf = (job: ReturnType<typeof reserved>): Record<string, unknown> => Object.fromEntries(Object.entries(job).map(([key, value]) => [column(key), value]));

describe('image job SQL timestamp boundary', () => {
    it.each([
        ['Date objects', (value: string) => new Date(value)],
        ['UTC SQL text', (value: string) => value.replace('T', ' ').replace('Z', '+00')],
        ['microsecond SQL text', (value: string) => value.replace('T', ' ').replace('Z', '901+00')],
        ['positive offset SQL text', (value: string) => new Date(Date.parse(value) + 19800000).toISOString().replace('T', ' ').replace('Z', '+05:30')],
        ['negative offset SQL text', (value: string) => new Date(Date.parse(value) - 12600000).toISOString().replace('T', ' ').replace('Z', '-03:30')],
    ] as const)('normalizes every timestamp column from %s', (_name, encode) => {
        const job = finished(), row = rowOf(job);
        for (const key of timestamps) row[column(key)] = encode(job[key]!);
        expect(parseImageJobRow(row)).toEqual(job);
    });

    it('accepts PostgreSQL zero-fraction text and preserves nullable timestamps', () => {
        const job = reserved(), row = rowOf(job);
        row.created_at = job.createdAt.replace('T', ' ').replace('.000Z', '+00');
        row.updated_at = row.created_at;
        expect(parseImageJobRow(row)).toEqual(job);
    });

    it('reproduces the production Drizzle codec without opening a connection', async () => {
        const client = postgres({ host: '127.0.0.1', database: 'unused', username: 'unused', password: 'unused',
            max: 10, idle_timeout: 20, prepare: false });
        try {
            const text = '2026-10-22 19:28:51.068+00';
            expect(client.options.parsers[1184]!(text)).toBeInstanceOf(Date);
            drizzle(client);
            expect(client.options.parsers[1184]!(text)).toBe(text);
            const job = finished(), row = rowOf(job);
            for (const key of timestamps) row[column(key)] = client.options.parsers[1184]!(job[key]!.replace('T', ' ').replace('Z', '+00'));
            expect(parseImageJobRow(row)).toEqual(job);
        } finally { await client.end(); }
    });

    it.each(timestamps)('rejects malformed SQL %s without numeric/object coercion', key => {
        const row = rowOf(finished());
        for (const value of ['', 'not-a-date', 'infinity', '-infinity', new Date(NaN), 0, 1792695600000, true, {}, undefined]) {
            expect(() => parseImageJobRow({ ...row, [column(key)]: value })).toThrow();
        }
    });

    it.each(['createdAt', 'updatedAt'] as const)('rejects NULL in required %s', key => {
        expect(() => parseImageJobRow({ ...rowOf(reserved()), [column(key)]: null })).toThrow();
    });

    it.each(timestamps)('keeps wire %s strict while normalizing its SQL column', key => {
        const job = finished();
        for (const value of [job[key]!.replace('T', ' ').replace('Z', '+00'), job[key]!.replace('Z', '901Z'), new Date(job[key]!)]) {
            expect(() => validateImageJob({ ...job, [key]: value })).toThrow();
        }
    });

    it('does not normalize nested JSON release timestamps', () => {
        const job = reserved();
        expect(() => parseImageJobRow({ ...rowOf(job), source_release: { ...job.sourceRelease,
            createdAt: job.sourceRelease.createdAt.replace('T', ' ').replace('Z', '+00') } })).toThrow();
    });

    it('writes only canonical millisecond timestamp binds through preparation and launch', async () => {
        const s = rebaseSetup();
        expect((await s.run('prepare')).status).toBe(202);
        await s.completePreparation();
        expect((await s.run('launch')).status).toBe(202);
        const statements = s.fake.statements.filter(q => /^(INSERT INTO|UPDATE) public\.ezil_computer_image_jobs/.test(q.sql));
        expect(statements.some(q => q.sql.startsWith('INSERT'))).toBe(true);
        expect(statements.some(q => q.sql.startsWith('UPDATE'))).toBe(true);
        for (const statement of statements) {
            expect(statement.sql).not.toMatch(/\bnow\(|CURRENT_TIMESTAMP|LOCALTIMESTAMP/i);
            const binds = [...statement.sql.matchAll(/\$(\d+)::timestamptz\b/g)];
            expect(binds.length).toBeGreaterThanOrEqual(5);
            for (const bind of binds) {
                const value = statement.params[Number(bind[1]) - 1];
                if (value !== null) expect(RebaseTime.safeParse(value).success).toBe(true);
            }
        }
    });

    it('rejects sub-millisecond writes before they can invalidate exact timestamp CAS', async () => {
        const s = rebaseSetup();
        expect((await s.run('prepare')).status).toBe(202);
        const job = await s.current();
        await expect(s.store.transition(job, { ...job, phase: 'fencing', updatedAt: '2026-10-22T12:00:01.000901Z' })).rejects.toThrow();
        expect(await s.current()).toEqual(job);
        const next = await s.store.transition(job, { ...job, phase: 'fencing', updatedAt: '2026-10-22T12:00:01.001Z' });
        expect(next.updatedAt).toBe('2026-10-22T12:00:01.001Z');
        await expect(s.store.transition(job, { ...job, phase: 'fencing', updatedAt: '2026-10-22T12:00:01.002Z' })).rejects.toThrow();
    });

    it('requires each same-phase update to consume a strictly older millisecond timestamp', async () => {
        const s = rebaseSetup();
        expect((await s.run('prepare')).status).toBe(202);
        const job = await s.current();
        for (const updatedAt of [job.updatedAt, job.createdAt]) {
            await expect(s.store.transition(job, { ...job, updatedAt })).rejects.toThrow('image_job_conflict');
        }
        expect(await s.current()).toEqual(job);
    });
});
