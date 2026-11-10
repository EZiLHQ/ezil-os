import 'server-only';

import type { GitTree, RepoFetcher } from './git-smart-http';
import type { ProjectRepoGrant } from './project-repo';

/**
 * The read-only fallback view of a project repository (os-map-design §5): when the user's computer cannot start,
 * the OS server fetches the branch tip itself with the same Universe `open` grant and returns the file tree plus the
 * text of every text file up to 256 KB. The Git token and the remote never leave the server: only paths, sizes and
 * file text do.
 */
export const SNAPSHOT_FILE_MAX_BYTES = 256 * 1024;
export const SNAPSHOT_TEXT_BUDGET_BYTES = 8 * 1024 * 1024;
export const SNAPSHOT_MAX_ENTRIES = 5000;

export interface SnapshotEntry {
    path: string;
    kind: 'file' | 'dir' | 'symlink' | 'submodule';
    /** Files only. */
    size?: number;
    executable?: true;
    /** A text file within every limit. */
    text?: string;
    /** A file whose text is not included, and why. */
    omitted?: 'binary' | 'too_large' | 'budget';
}

export interface RepoSnapshot {
    projectId: string;
    repositoryId: string;
    ref: string;
    head: string;
    role: 'builder' | 'client';
    entries: SnapshotEntry[];
    /** Entries or text were left out by the overall limits (not by a single file's size). */
    truncated: boolean;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Text only: no NUL byte and valid UTF-8. */
function asText(content: Uint8Array): string | undefined {
    if (content.includes(0)) return undefined;
    try { return utf8.decode(content); } catch { return undefined; }
}

export function buildSnapshot(tree: GitTree, grant: ProjectRepoGrant): RepoSnapshot {
    const entries: SnapshotEntry[] = [];
    let budget = SNAPSHOT_TEXT_BUDGET_BYTES;
    let truncated = false;
    for (const entry of tree.entries) {
        if (entries.length >= SNAPSHOT_MAX_ENTRIES) { truncated = true; break; }
        if (entry.kind !== 'file') { entries.push({ path: entry.path, kind: entry.kind }); continue; }
        const content = entry.content ?? new Uint8Array();
        const out: SnapshotEntry = { path: entry.path, kind: 'file', size: content.byteLength, ...(entry.mode === '100755' ? { executable: true as const } : {}) };
        if (content.byteLength > SNAPSHOT_FILE_MAX_BYTES) out.omitted = 'too_large';
        else {
            const text = asText(content);
            if (text === undefined) out.omitted = 'binary';
            else if (content.byteLength > budget) { out.omitted = 'budget'; truncated = true; }
            else { out.text = text; budget -= content.byteLength; }
        }
        entries.push(out);
    }
    return {
        projectId: grant.binding.projectId, repositoryId: grant.binding.repositoryId, ref: grant.binding.ref,
        head: tree.head, role: grant.role, entries, truncated,
    };
}

/** Fetch with `fetcher` (the in-memory smart-HTTP client by default) and shape the answer. */
export async function snapshotProjectRepository(grant: ProjectRepoGrant, fetcher: RepoFetcher, signal?: AbortSignal): Promise<RepoSnapshot> {
    const tree = await fetcher({
        canonicalURL: grant.binding.canonicalURL, ref: grant.binding.ref,
        username: grant.git.username, token: grant.git.token, signal,
    });
    return buildSnapshot(tree, grant);
}
