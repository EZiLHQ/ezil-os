import { describe, expect, it } from 'vitest';
import { MIGRATION_STATES, pendingRecovery, reduceMigration, restoreFetchBase, restoreLeaseFor, type MigrationEvent, type MigrationProgress } from './provider-migrate';
import { buildAwsProvisionUserData } from './aws-ec2';

const G = '11111111-1111-4111-8111-111111111111';
const H = '22222222-2222-4222-8222-222222222222';
const head = { version: 1, generation: G, entries: 0, sha256: 'a'.repeat(64), chunks: [{ size: 1024, sha256: 'b'.repeat(64) }] };
const base: MigrationProgress = { state: 'requested', generation: G, sourceEtag: 'source', sourceSystemEtag: null, workspaceHead: head, systemHead: null, migratedEtag: null, attempts: 0, lastError: null };
const transitions: [MigrationProgress['state'], MigrationEvent, MigrationProgress['state']][] = [
    ['requested', { type: 'fenced', etag: 'source', systemEtag: null, generation: G }, 'fenced'],
    ['fenced', { type: 'exported', workspaceHead: head, systemHead: null }, 'exported'],
    ['exported', { type: 'provisioned' }, 'provisioning'],
    ['provisioning', { type: 'host_restored', generation: G }, 'restored'],
    ['restored', { type: 'committed', migratedEtag: 'migrated' }, 'committed'],
];
describe('migration reducer', () => {
    for (const state of MIGRATION_STATES) for (const [from, event, to] of transitions) {
        it(`${state} + ${event.type} ${state === from ? `-> ${to}` : 'is illegal'}`, () => {
            const input = { ...base, state };
            const result = reduceMigration(input, event);
            expect(result.accepted).toBe(state === from);
            expect(result.migration.state).toBe(state === from ? to : state);
            expect(input).toEqual({ ...base, state });
        });
    }
    it('carries the fence, both exports (system generation can differ), and migrated ETag', () => {
        let m = reduceMigration(base, { type: 'fenced', etag: 'fence', systemEtag: 'system', generation: G }).migration;
        expect(m).toMatchObject({ sourceEtag: 'fence', sourceSystemEtag: 'system', generation: G });
        m = reduceMigration(m, { type: 'exported', workspaceHead: head, systemHead: { ...head, generation: H } }).migration;
        expect(m.systemHead?.generation).toBe(H);
        m = reduceMigration(m, { type: 'provisioned' }).migration;
        m = reduceMigration(m, { type: 'host_restored', generation: G }).migration;
        expect(reduceMigration(m, { type: 'committed', migratedEtag: 'new-etag' }).migration.migratedEtag).toBe('new-etag');
    });
    it.each([null, H])('refuses host acknowledgment with generation %s', generation => {
        expect(reduceMigration({ ...base, state: 'provisioning', generation }, { type: 'host_restored', generation: G }).accepted).toBe(false);
    });
    it('guards malformed fencing and exports', () => {
        expect(reduceMigration(base, { type: 'fenced', etag: '', systemEtag: null, generation: G }).accepted).toBe(false);
        expect(reduceMigration(base, { type: 'fenced', etag: 'x', systemEtag: null, generation: 'bad' }).accepted).toBe(false);
        for (const [m, workspaceHead, systemHead] of [
            [{ ...base, generation: null }, head, null], [base, { ...head, generation: H }, null],
            [base, head, head], [{ ...base, sourceSystemEtag: 'system' }, head, null],
        ] as const) expect(reduceMigration({ ...m, state: 'fenced' }, { type: 'exported', workspaceHead, systemHead }).accepted).toBe(false);
        expect(reduceMigration({ ...base, state: 'restored' }, { type: 'committed', migratedEtag: '' }).accepted).toBe(false);
    });
    for (const state of MIGRATION_STATES) {
        const terminal = ['committed', 'failed_reopened', 'failed_needs_operator'].includes(state);
        it(`${state}: retries are capped; failures await recovery confirmation`, () => {
            let m = { ...base, state };
            for (let i = 1; i <= 5; i++) {
                const r = reduceMigration(m, { type: 'error', step: 'export', retryable: true });
                expect(r.effect).toBe(terminal ? null : 'retry');
                expect(r.migration.attempts).toBe(terminal ? 0 : i);
                m = r.migration;
            }
            const r = reduceMigration(m, { type: 'error', step: 'export', retryable: true });
            expect(r.effect).toBe(terminal ? null : 'abort');
            expect(r.migration.state).toBe(state);
            expect(r.migration.attempts).toBe(terminal ? 0 : 5);
            const recovered = reduceMigration(r.migration, { type: 'reopened' });
            expect(recovered.migration.state).toBe(terminal ? state : 'failed_reopened');
            if (!terminal) {
                for (const [, event] of transitions) expect(reduceMigration(r.migration, event).accepted).toBe(false);
                expect(reduceMigration(r.migration, { type: 'error', step: 'abort', retryable: true }).migration.state).toBe('failed_needs_operator');
            }
            expect(reduceMigration({ ...base, state }, { type: 'reopened' }).accepted).toBe(false);
        });
        it(`${state}: nonretryable error and commit uncertainty`, () => {
            for (const step of ['begin', 'commit']) {
                const r = reduceMigration({ ...base, state }, { type: 'error', step, retryable: false });
                expect(r.effect).toBe(terminal ? null : step === 'commit' ? 'reopen' : 'abort');
                if (!terminal) {
                    expect(pendingRecovery(r.migration)).toBe(r.effect);
                    expect(reduceMigration(r.migration, { type: 'error', step: 'export', retryable: true }).effect).toBe(r.effect);
                    expect(reduceMigration(r.migration, { type: 'error', step: r.effect!, retryable: false }).migration.state).toBe('failed_needs_operator');
                }
            }
        });
    }
    it('does not accept an unsolicited or mismatched recovery failure', () => {
        expect(reduceMigration(base, { type: 'error', step: 'reopen', retryable: false }).accepted).toBe(false);
        const r = reduceMigration(base, { type: 'error', step: 'export', retryable: false });
        expect(reduceMigration(r.migration, { type: 'error', step: 'reopen', retryable: false }).accepted).toBe(false);
    });
});

describe('restore lease', () => {
    const token = Buffer.alloc(32, 7).toString('base64url');
    const migration = { ...base, state: 'exported' as const, id: H, computerId: G };
    const fetchBase = restoreFetchBase('https://app.example/path', G);
    const input = { computerId: G, volumeId: null, fsUuid: H, generation: 1, leaseEpoch: 1, nonce: token, provision: true, enrollUrl: 'https://app.example/api/compute/aws/enroll' };
    it('embeds the exact host restore shape only when explicitly supplied', () => {
        const restore = restoreLeaseFor(migration, token, fetchBase);
        expect(restore).toEqual({ kind: 'cf-snapshot', migrationId: H, generation: G, system: false, fetchBase: `https://app.example/api/compute/restore/${G}`, identityToken: token });
        const decode = (encoded: string) => JSON.parse(Buffer.from(encoded, 'base64').toString());
        expect(decode(buildAwsProvisionUserData(input))).not.toHaveProperty('restore');
        expect(decode(buildAwsProvisionUserData({ ...input, restore }))).toEqual({ ...decode(buildAwsProvisionUserData(input)), restore });
        expect(restoreLeaseFor({ ...migration, systemHead: { ...head, generation: H } }, token, fetchBase).system).toBe(true);
    });
    it('keeps maximal snapshot heads out of launch data with maximal credentials', () => {
        const maximal = { ...head, chunks: Array.from({ length: 512 }, () => ({ size: 1048576, sha256: 'f'.repeat(64) })) };
        const restore = restoreLeaseFor({ ...migration, workspaceHead: maximal, systemHead: maximal }, '_'.repeat(43), fetchBase);
        expect(restore).not.toHaveProperty('workspace');
        expect(restore.system).toBe(true);
        expect(JSON.stringify(restore).length).toBeLessThan(512);
        const encoded = buildAwsProvisionUserData({ ...input, nonce: '_'.repeat(128), restore });
        expect(encoded.length).toBeLessThan(2048);
        expect(JSON.parse(Buffer.from(encoded, 'base64').toString()).restore).toEqual(restore);
    });
    it.each(['requested', 'fenced', 'restored', 'committed', 'failed_reopened', 'failed_needs_operator'] as const)('refuses lease in %s', state => {
        expect(() => restoreLeaseFor({ ...migration, state }, token, fetchBase)).toThrow();
    });
    it('guards capability scope and exported generation', () => {
        for (const bad of [{ id: 'bad' }, { computerId: 'bad' }, { generation: 'bad', workspaceHead: { generation: 'bad' } }, { generation: null }, { workspaceHead: null }, { generation: H }, { lastError: 'recovery:abort:export' }])
            expect(() => restoreLeaseFor({ ...migration, ...bad }, token, fetchBase)).toThrow();
        for (const url of [fetchBase + '?x=1', fetchBase + '#x', fetchBase.replace(G, H), fetchBase.replace('https:', 'ftp:'), fetchBase.replace('app.example', 'user@app.example')])
            expect(() => restoreLeaseFor(migration, token, url)).toThrow();
        expect(() => restoreLeaseFor(migration, 'bad', fetchBase)).toThrow();
        expect(() => restoreFetchBase('https://app.example', 'bad')).toThrow();
    });
});
