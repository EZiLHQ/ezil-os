import type { db } from '@/server/db';
import { deriveGuacamoleSandboxId, resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import { readPlacement } from '@/server/lib/compute/placement';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER, previewTokenV2Enabled } from '@/server/lib/compute/preview-token-v2';

import { liveOwnedComputer } from './computer-store';
import { editorWorkerOrigin } from '../parity-config';

type ReadDatabase = Pick<typeof db, 'query' | 'execute'>;
type Balance = { balanceMicro: string; heldMicro: string };
type BalanceFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function currentPlacement(database: ReadDatabase, userId: string, computerId: string) {
    const owned = await database.query.computers.findFirst({
        where: liveOwnedComputer(userId, computerId), columns: { id: true },
    });
    if (!owned) return null;
    const { record } = await readPlacement(database, computerId, userId);
    // Cloudflare placement is pinned at generation 1 / epoch 0, with 0 / 0
    // for legacy rows. The Worker owns live readiness for either row state.
    if (!record || record.provider !== 'cloudflare' || record.leaseEpoch !== 0
        || (record.generation !== 0 && record.generation !== 1)
        || (record.state !== 'STOPPED' && record.state !== 'RUNNING')) return null;
    return { provider: record.provider, generation: record.generation, leaseEpoch: record.leaseEpoch,
        revision: record.updatedAt.getTime() };
}

async function parseBalance(response: Response): Promise<Balance | null> {
    if (!response.ok || !response.body) {
        void response.body?.cancel().catch(() => undefined);
        return null;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 512) {
            void reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    const amount = (item: unknown): item is string => typeof item === 'string' && /^(?:0|[1-9]\d{0,99})$/.test(item);
    if (!value || Object.keys(value).length !== 2 || !amount(value.balanceMicro) || !amount(value.heldMicro)) return null;
    return { balanceMicro: value.balanceMicro, heldMicro: value.heldMicro };
}

/** Uses only the owned computer's existing in-Worker credential. No direct Gateway token reaches this caller. */
export async function readSettingsAiBalance(
    database: ReadDatabase, userId: string, computerIds: readonly string[],
    signal: AbortSignal | undefined, fetchImpl: BalanceFetch = fetch,
): Promise<Balance | null> {
    const workerOrigin = editorWorkerOrigin(process.env);
    if (!workerOrigin || !computerIds.length || !previewTokenV2Enabled() || signal?.aborted) return null;
    const config = resolveCloudflareGuacamoleConfig();
    const secret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    if (!config.isConfigured || config.workerUrl.replace(/\/$/, '') !== workerOrigin || !secret) return null;
    for (const computerId of computerIds) {
        if (signal?.aborted) return null;
        try {
            const placement = await currentPlacement(database, userId, computerId);
            if (!placement) continue;
            const sandboxId = deriveGuacamoleSandboxId(userId, computerId);
            const path = '/sandbox/' + sandboxId + '/ai-credential';
            const { revision, ...binding } = placement;
            const assertion = mintPreviewTokenV2(secret, {
                ...binding, ts: Date.now(), sandboxId, computerId, userId, store: '',
            }, { method: 'GET', path, body: '' });
            const timeout = AbortSignal.timeout(4_000);
            const response = await fetchImpl(workerOrigin + path, {
                method: 'GET', headers: { [PREVIEW_TOKEN_V2_HEADER]: assertion, accept: 'application/json' },
                redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            });
            const balance = await parseBalance(response);
            if (!balance) continue;
            const after = await currentPlacement(database, userId, computerId);
            if (after?.provider === placement.provider && after.generation === placement.generation
                && after.leaseEpoch === placement.leaseEpoch && after.revision === revision) return balance;
        } catch {
            // Unknown placement, expired credential and unavailable balance are all read misses.
        }
    }
    return null;
}
