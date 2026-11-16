/** Repository errors survive container log rotation in the existing telemetry table and consented feedback. */
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import { shellJson } from '@/server/shell/http';
import { isRepoOpenFailureReason } from '@/server/lib/compute/repo-open';
import { ingestBatch, type IngestDb } from '@/server/telemetry/ingest';
import { shouldShedLoad, type RowEstimateDb } from '@/server/telemetry/load-shed';
import { isRateLimited } from '@/server/telemetry/rate-limit';
import { safeUserHash } from '@/server/telemetry/sanitize';
import { telemetryEventInputSchema } from '@/server/telemetry/schema';
import { isCorrelationId } from './failure-shapes';

type Failure = { refusalReason?: unknown; correlationId?: unknown; httpStatus?: unknown };
type Db = IngestDb & RowEstimateDb;

/** Only closed producer codes, one request ID and optional status. No URL, grant, author, exception or body. */
export function repoOpenFailureDiagnostic(failure: Failure) {
    const refusalReason = isRepoOpenFailureReason(failure.refusalReason) ? failure.refusalReason : 'repo_open:transport:other';
    const correlationId = isCorrelationId(failure.correlationId) ? failure.correlationId : randomUUID();
    const status = /^repo_open:worker_http_([1-5][0-9]{2}):/.exec(refusalReason)?.[1];
    return { refusalReason, correlationId, ...(status ? { httpStatus: Number(status) } : {}) };
}

/** Same row/rate guards and single writer as other telemetry, after the response. Failure cannot block Code. */
export function repoOpenFailureResponse(
    db: Db, userId: string, computerId: string, failure: Failure, message: string,
    schedule: (work: () => Promise<void>) => void = after,
): Response {
    const diagnostic = repoOpenFailureDiagnostic(failure);
    const occurredAt = new Date().toISOString();
    try {
        schedule(async () => {
            try {
                const userHash = safeUserHash(userId);
                if (isRateLimited(userHash) || shouldShedLoad(db)) return;
                const event = telemetryEventInputSchema.parse({
                    eventId: randomUUID(), schemaVersion: 1, eventClass: 'api_failure', source: 'app',
                    occurredAt, site: 'ezil-os:repo-open#transport', code: 'repo_open_failed', outcome: 'error',
                    detail: diagnostic.refusalReason, correlationId: diagnostic.correlationId, computerId,
                    ...(diagnostic.httpStatus ? { attrs: { status: diagnostic.httpStatus } } : {}),
                });
                await ingestBatch(db, [event], userHash);
            } catch {
                console.warn('[repo-open] diagnostic persistence unavailable', { correlationId: diagnostic.correlationId });
            }
        });
    } catch {
        console.warn('[repo-open] diagnostic scheduling unavailable', { correlationId: diagnostic.correlationId });
    }
    // Technical details are for diagnostics, never substituted for the user's plain failure copy.
    return shellJson({ error: { code: 'repo_open_failed', message },
        refusalReason: diagnostic.refusalReason, correlationId: diagnostic.correlationId }, 502);
}
