import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { buildSnapshot, SNAPSHOT_FILE_MAX_BYTES, SNAPSHOT_MAX_ENTRIES, SNAPSHOT_TEXT_BUDGET_BYTES, snapshotProjectRepository } from './repo-snapshot';
import type { GitTreeEntry } from './git-smart-http';
import type { ProjectRepoGrant } from './project-repo';

const TOKEN = `art_v1_${'5'.repeat(64)}`;
const grant: ProjectRepoGrant = {
    binding: { projectId: '3333abcd-3333-4333-8333-33333333cdef', repositoryId: '44444444-4444-4444-8444-44444444abcd',
        canonicalURL: `https://${'0123456789abcdef'.repeat(2)}.artifacts.cloudflare.net/git/universe-staging/p-3333abcd-3333-4333-8333-33333333cdef.git`,
        ref: 'refs/heads/main', bindingVersion: '1' },
    role: 'client', git: { username: 'ezil', token: TOKEN, expiresAt: '2026-10-31T12:05:00.000Z', scope: 'read' },
};
const file = (path: string, content: Uint8Array | string, mode = '100644'): GitTreeEntry => {
    const bytes = typeof content === 'string' ? Buffer.from(content) : content;
    return { path, kind: 'file', mode, size: bytes.byteLength, content: bytes };
};
const head = 'e'.repeat(40);

describe('buildSnapshot', () => {
    it('keeps the tree, includes text, and says why any file\'s text is left out', () => {
        const snapshot = buildSnapshot({ head, entries: [
            { path: 'src', kind: 'dir', mode: '40000' },
            file('src/a.ts', 'export const a = 1;\n'),
            file('run.sh', '#!/bin/sh\n', '100755'),
            file('logo.png', Buffer.from([0x89, 0x50, 0, 1])),
            file('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9])),
            file('big.txt', 'x'.repeat(SNAPSHOT_FILE_MAX_BYTES + 1)),
            file('edge.txt', 'y'.repeat(SNAPSHOT_FILE_MAX_BYTES)),
            { path: 'link', kind: 'symlink', mode: '120000' },
            { path: 'vendor/lib', kind: 'submodule', mode: '160000' },
        ] }, grant);
        expect(snapshot).toMatchObject({ projectId: grant.binding.projectId, repositoryId: grant.binding.repositoryId, ref: 'refs/heads/main', head, role: 'client', truncated: false });
        expect(snapshot.entries).toEqual([
            { path: 'src', kind: 'dir' },
            { path: 'src/a.ts', kind: 'file', size: 20, text: 'export const a = 1;\n' },
            { path: 'run.sh', kind: 'file', size: 10, executable: true, text: '#!/bin/sh\n' },
            { path: 'logo.png', kind: 'file', size: 4, omitted: 'binary' },
            { path: 'latin1.txt', kind: 'file', size: 4, omitted: 'binary' },
            { path: 'big.txt', kind: 'file', size: SNAPSHOT_FILE_MAX_BYTES + 1, omitted: 'too_large' },
            { path: 'edge.txt', kind: 'file', size: SNAPSHOT_FILE_MAX_BYTES, text: 'y'.repeat(SNAPSHOT_FILE_MAX_BYTES) },
            { path: 'link', kind: 'symlink' },
            { path: 'vendor/lib', kind: 'submodule' },
        ]);
        expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    });

    it('stops including text at the overall budget and the tree at the entry cap, and says so', () => {
        const count = Math.ceil(SNAPSHOT_TEXT_BUDGET_BYTES / SNAPSHOT_FILE_MAX_BYTES) + 2;
        const budgeted = buildSnapshot({ head, entries: Array.from({ length: count }, (_, i) => file(`f${i}.txt`, 'z'.repeat(SNAPSHOT_FILE_MAX_BYTES))) }, grant);
        expect(budgeted.truncated).toBe(true);
        expect(budgeted.entries.filter(e => e.text !== undefined)).toHaveLength(SNAPSHOT_TEXT_BUDGET_BYTES / SNAPSHOT_FILE_MAX_BYTES);
        expect(budgeted.entries.at(-1)).toMatchObject({ omitted: 'budget' });
        const many = buildSnapshot({ head, entries: Array.from({ length: SNAPSHOT_MAX_ENTRIES + 5 }, (_, i) => ({ path: `d${i}`, kind: 'dir' as const, mode: '40000' })) }, grant);
        expect(many.entries).toHaveLength(SNAPSHOT_MAX_ENTRIES);
        expect(many.truncated).toBe(true);
    });
});

describe('snapshotProjectRepository', () => {
    it('hands the fetcher the binding and the grant, and returns only the shaped snapshot', async () => {
        const fetcher = vi.fn(async () => ({ head, entries: [file('a.txt', 'a')] }));
        const signal = new AbortController().signal;
        const snapshot = await snapshotProjectRepository(grant, fetcher, signal);
        expect(fetcher).toHaveBeenCalledWith({ canonicalURL: grant.binding.canonicalURL, ref: 'refs/heads/main', username: 'ezil', token: TOKEN, signal });
        expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
        expect(snapshot.entries).toEqual([{ path: 'a.txt', kind: 'file', size: 1, text: 'a' }]);
    });
});
