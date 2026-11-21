import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { consentVersion, readEvidencePilot, type EvidencePilot } from './contract';
import { handleEvidenceRequest } from './http';
import { evidenceStore } from './store';

const pgUrl = process.env.EZIL_ASSIGNMENT_EVIDENCE_PG_TEST_URL;
const pilot: EvidencePilot = {
    id: randomUUID(), ownerId: randomUUID(), computerId: randomUUID(),
    repositoryId: 'syntheticevidence', repositoryUrl: 'https://github.ezil.work/default/synthetic-evidence.git',
    ref: 'refs/heads/main', baseSha: 'a'.repeat(40),
};
const route = 'https://os-staging.ezil.work/api/shell/assignment-evidence';

it('enables only a complete, literal staging pilot configuration', () => {
    const config = JSON.stringify(pilot);
    const stage = 'https://ai-staging.ezil.work';
    expect(readEvidencePilot({ BILLING_FUNDING_URL: stage, EZIL_ASSIGNMENT_EVIDENCE_PILOT: config })).toEqual(pilot);
    expect(readEvidencePilot({ BILLING_FUNDING_URL: 'https://ai.ezil.work', EZIL_ASSIGNMENT_EVIDENCE_PILOT: config })).toBeNull();
    expect(readEvidencePilot({ BILLING_FUNDING_URL: stage, EZIL_ASSIGNMENT_EVIDENCE_PILOT: '{"wrong":true}' })).toBeNull();
});

let client: ReturnType<typeof postgres>;
let store: ReturnType<typeof evidenceStore>;

beforeAll(async () => {
    if (!pgUrl) return;
    const url = new URL(pgUrl);
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/assignment_evidence_test') {
        throw new Error('Use a disposable local assignment_evidence_test database');
    }
    client = postgres(pgUrl, { max: 4, prepare: false });
    await client.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    END $$;`);
    await client.unsafe(await readFile(new URL('../../../drizzle/0034_assignment_evidence_pilot.sql', import.meta.url), 'utf8'));
    store = evidenceStore(drizzle(client));
});

afterAll(async () => {
    await client?.end();
});

it.skipIf(!pgUrl)('keeps one owner-bound ordered trace with durable receipts, retries, and explicit stop', async () => {
    let now = Date.parse('2026-11-21T20:30:00Z');
    let granted = false;
    const deps = { pilot, ownerId: pilot.ownerId, store, now: () => now, authorizeStart: async () => granted };
    const post = (payload: unknown, options: { crossOrigin?: boolean; other?: boolean } = {}) => handleEvidenceRequest(new Request(route, {
        method: 'POST', body: JSON.stringify(payload),
        headers: { 'sec-fetch-site': options.crossOrigin ? 'same-site' : 'same-origin' },
    }), { ...deps, ...(options.other ? { ownerId: randomUUID() } : {}) });
    const get = (tail = '', other = false) => handleEvidenceRequest(new Request(route + tail), { ...deps, ownerId: other ? randomUUID() : pilot.ownerId });
    const command = { action: 'start', computerId: pilot.computerId, consentVersion };

    expect((await get('', true)).status).toBe(404);
    expect((await post(command, { crossOrigin: true })).status).toBe(404);
    expect((await post(command)).status).toBe(404);
    granted = true;
    expect((await post({ ...command, computerId: randomUUID() })).status).toBe(404);

    const first = await Promise.all([post(command), post(command)]);
    const [created, retry] = await Promise.all(first.map(reply => reply.json()));
    expect(created.attempt).toMatchObject({ state: 'active', startedAt: '2026-11-21T20:30:00.000Z' });
    expect(retry.attempt.id).toBe(created.attempt.id);
    const attemptId: string = created.attempt.id;
    now += 250;
    const event = { id: randomUUID(), kind: 'app.focused', occurredAt: new Date(now).toISOString(), detail: { app: 'code' } };
    const file = { id: randomUUID(), kind: 'code.file_opened', occurredAt: event.occurredAt, detail: { path: 'src/employee.ts' } };
    const append = (events: unknown[]) => post({ action: 'append', attemptId, events });
    expect((await append([{ ...event, detail: { app: 'code', keystroke: 'do not store' } }])).status).toBe(400);
    expect((await append([{ ...event, detail: { app: 'preview' } }])).status).toBe(400);
    expect((await append([{ ...file, detail: { path: '.env.local' } }])).status).toBe(400);
    expect((await append([{ ...file, occurredAt: '2026-01-01T00:00:00.000Z' }])).status).toBe(409);
    expect((await append([event, event])).status).toBe(400);
    expect((await post({ action: 'append', attemptId, events: [event] }, { other: true })).status).toBe(404);
    expect(await (await append([event, file])).json()).toEqual({ accepted: [event.id, file.id] });
    expect(await (await append([event])).json()).toEqual({ accepted: [event.id] });
    expect((await append([{ ...event, kind: 'app.closed' }])).status).toBe(409);

    now += 500;
    expect((await (await post({ action: 'end', attemptId })).json()).attempt.state).toBe('ended');
    expect((await (await post({ action: 'end', attemptId })).json()).attempt.state).toBe('ended');
    expect((await append([{ ...event, id: randomUUID() }])).status).toBe(409);
    expect((await get('?attemptId=' + attemptId, true)).status).toBe(404);

    await expect(client.begin(async tx => {
        await tx`SET LOCAL ROLE authenticated`;
        await tx`SELECT id FROM public.ezil_assignment_evidence_attempts`;
    })).rejects.toMatchObject({ code: '42501' });

    const report = await (await get('?attemptId=' + attemptId)).json();
    expect(report.elapsedMs).toBe(750);
    expect(report.binding).toMatchObject({ assignmentId: pilot.id, computerId: pilot.computerId, repositoryId: pilot.repositoryId, baseSha: pilot.baseSha });
    expect(report.events.map((row: { kind: string; sequence: number; source: string }) => [row.kind, row.sequence, row.source])).toEqual([
        ['assignment.started', 1, 'server_observed'],
        ['app.focused', 2, 'client_reported'],
        ['code.file_opened', 3, 'client_reported'],
        ['assignment.ended', 4, 'server_observed'],
    ]);
    expect((await (await get('?attemptId=' + attemptId + '&after=3')).json()).events).toHaveLength(1);
});
