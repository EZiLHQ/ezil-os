import { z } from 'zod';

import { isCrossOriginWrite } from '@/utils/request-origin';

import { commandSchema, consentVersion, uuid, type EvidencePilot } from './contract';
import type { EvidenceStore } from './store';

type EvidenceRequest = {
    pilot: EvidencePilot;
    ownerId: string;
    store: EvidenceStore;
    authorizeStart: (pilot: EvidencePilot, signal: AbortSignal) => Promise<boolean>;
    now?: () => number;
};

const maxBodyBytes = 160 * 1024;
const reportQuery = z.object({
    attemptId: uuid,
    after: z.string().regex(/^(?:0|[1-9]\d{0,4})$/).transform(Number).default('0'),
}).strict();

export function evidenceJson(value: unknown, status = 200): Response {
    return Response.json(value, { status, headers: { 'cache-control': 'private, no-store' } });
}

export function evidenceUnavailable(): Response {
    return evidenceJson({ error: 'not_found' }, 404);
}

async function readCommand(req: Request): Promise<unknown> {
    const reader = req.body?.getReader();
    if (!reader) return;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > maxBodyBytes) return;
            chunks.push(chunk.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        return;
    } finally {
        void reader.cancel().catch(() => {});
    }
}

export async function handleEvidenceRequest(req: Request, deps: EvidenceRequest): Promise<Response> {
    const { pilot, store } = deps;
    if (deps.ownerId !== pilot.ownerId || isCrossOriginWrite(req)) return evidenceUnavailable();

    const clock = deps.now ?? Date.now;
    if (req.method === 'GET') {
        const pairs = [...new URL(req.url).searchParams.entries()];
        if (!pairs.length) {
            return evidenceJson({
                enabled: true,
                assignment: { id: pilot.id, computerId: pilot.computerId, repositoryUrl: pilot.repositoryUrl,
                    captureChat: pilot.captureChat === true },
                attempt: await store.current(pilot, clock()),
            });
        }

        const query = reportQuery.safeParse(Object.fromEntries(pairs));
        if (!query.success || pairs.length !== new Set(pairs.map(([key]) => key)).size) {
            return evidenceJson({ error: 'invalid_query' }, 400);
        }
        const report = await store.report(pilot, query.data.attemptId, query.data.after, clock());
        return report ? evidenceJson(report) : evidenceUnavailable();
    }
    if (req.method !== 'POST') return evidenceUnavailable();

    const command = commandSchema.safeParse(await readCommand(req));
    if (!command.success) return evidenceJson({ error: 'invalid_event_request' }, 400);

    const action = command.data;
    if (action.action === 'start') {
        if (action.computerId !== pilot.computerId) return evidenceUnavailable();
        const captureChat = action.captureChat === true;
        if (captureChat !== (pilot.captureChat === true) || (captureChat && action.consentVersion !== consentVersion)) {
            return evidenceJson({ error: 'consent_required' }, 409);
        }
        if (!(await deps.authorizeStart(pilot, req.signal))) return evidenceUnavailable();
        const attempt = await store.start(pilot, clock(), { version: action.consentVersion, captureChat });
        return attempt ? evidenceJson({ attempt }) : evidenceUnavailable();
    }
    if (action.action === 'end') {
        const attempt = await store.end(pilot, action.attemptId, clock());
        return attempt ? evidenceJson({ attempt }) : evidenceUnavailable();
    }
    const receipt = await store.append(pilot, action.attemptId, action.events, clock());
    if (receipt === 'not_found') return evidenceUnavailable();
    return typeof receipt === 'string' ? evidenceJson({ error: receipt }, 409) : evidenceJson(receipt);
}
