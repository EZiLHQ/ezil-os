import { db } from '@/server/db';
import { deriveGuacamoleSandboxId, migrateExport, MIGRATE_HEAD_LIMIT } from '../cloudflare-guacamole-provider';
import { createProviderMigrationStore, restoreTokenMatches } from './provider-migrate-store';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const noStore = { 'Cache-Control': 'no-store' };
export type RestoreParams = { computerId: string; kind: string; index?: string };

/** Capability-only endpoint: no session cookie, redirects, or upstream error text. */
export async function proxyMigrationRestore(req: Request, params: RestoreParams): Promise<Response> {
    const generation = new URL(req.url).searchParams.get('generation');
    if (!UUID.test(params.computerId) || !generation || !UUID.test(generation)
        || (params.kind !== 'workspace' && params.kind !== 'system')
        || (params.index !== undefined && (!/^(0|[1-9][0-9]*)$/.test(params.index) || Number(params.index) > 511)))
        return new Response(null, { status: 400, headers: noStore });
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
    if (!token) return new Response(null, { status: 401, headers: noStore });
    const computerId = params.computerId.toLowerCase();
    const gen = generation.toLowerCase();
    try {
        const store = createProviderMigrationStore(db);
        if (!await store.verifyRestoreToken(computerId, gen, token))
            return new Response(null, { status: 401, headers: noStore });
        const migration = await store.readActiveByComputer(computerId);
        if (!restoreTokenMatches(migration, computerId, gen, token, new Date()) || !migration)
            return new Response(null, { status: 401, headers: noStore });
        // System checkpoints have a separate Worker generation. The host's
        // capability remains scoped to the migration generation on every read.
        const sourceGeneration = params.kind === 'system' ? migration.systemHead?.generation : gen;
        if (!sourceGeneration) return new Response(null, { status: 404, headers: noStore });
        if (!UUID.test(sourceGeneration)) return new Response(null, { status: 503, headers: noStore });
        const result = await migrateExport(deriveGuacamoleSandboxId(migration.userId, computerId), params.kind,
            sourceGeneration, params.index === undefined ? undefined : Number(params.index));
        if (!result.ok) return new Response(null, {
            status: result.error === 'not_found' ? 404 : result.error === 'conflict' ? 409 : 503, headers: noStore,
        });
        if (params.kind === 'system' && params.index === undefined) {
            const head: unknown = await result.data.json();
            if (!head || typeof head !== 'object' || Array.isArray(head)
                || (head as Record<string, unknown>).generation !== sourceGeneration)
                return new Response(null, { status: 409, headers: noStore });
            // Only the exported head generation is projected into lease scope;
            // archive/chunk hashes and chunkGeneration retain their exact values.
            const body = JSON.stringify({ ...head, generation: gen });
            if (Buffer.byteLength(body) > MIGRATE_HEAD_LIMIT)
                return new Response(null, { status: 503, headers: noStore });
            return new Response(body, { headers: { ...noStore, 'Content-Type': 'application/json' } });
        }
        const headers = new Headers(noStore);
        headers.set('Content-Type', params.index === undefined ? 'application/json' : 'application/octet-stream');
        for (const name of ['x-ezil-chunk-sha256', 'content-length']) {
            const value = result.data.headers.get(name);
            if (value !== null) headers.set(name, value);
        }
        if (params.index !== undefined && result.data.status === 200 && result.data.body) {
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    store.recordRestoreChunk(migration, params.kind, Number(params.index)),
                    new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('restore_progress_timeout')), 250); }),
                ]);
            } catch {
                console.warn('[compute.migration.restore] progress unavailable', { migrationId: migration.id });
            } finally { clearTimeout(timeout); }
        }
        return new Response(result.data.body, { headers });
    } catch {
        return new Response(null, { status: 503, headers: noStore });
    }
}
