import { createHmac } from 'node:crypto';
import type { AiCreditEntitlement } from './ai-credits';

export const AI_GATEWAY_TIMEOUT_MS = 10_000;
export type AiGatewayEvent = AiCreditEntitlement & { eventId: string; accountPublicId: string; action: 'grant' | 'revoke' };
export type AiGatewayResult = { status: 'ok' } | { status: 'permanent' | 'retryable'; reason: string };
export type AiLogger = (message: string, fields?: { entitlementId: string }) => void;

export function signAiGatewayBody(secret: string, timestamp: string, rawBody: string): string {
    return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`;
}

/** Bounds the whole operation, including response bodies and auth reads, even if an adapter ignores abort. */
export async function withAiTimeout<T>(ms: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('ai_timeout')); }, ms);
        })]);
    } finally { clearTimeout(timer); }
}

export async function sendAiCreditEvent(input: {
    url: string; secret: string; event: AiGatewayEvent; now?: () => number; fetch?: typeof fetch; log?: AiLogger;
}): Promise<AiGatewayResult> {
    const { event } = input;
    // Serialize exactly once. Neither delivery metadata nor credentials belong in the body.
    const rawBody = JSON.stringify({ eventId: event.eventId, entitlementId: event.entitlementId,
        accountPublicId: event.accountPublicId, action: event.action, credits: event.credits, expiresAt: event.expiresAt });
    const timestamp = String(Math.floor((input.now ?? Date.now)() / 1000));
    try {
        return await withAiTimeout(AI_GATEWAY_TIMEOUT_MS, async signal => {
            const response = await (input.fetch ?? fetch)(`${input.url.replace(/\/$/, '')}/v1/integrations/entitlements`, {
                method: 'POST', redirect: 'error', signal, headers: { 'Content-Type': 'application/json',
                    'X-EZiL-Timestamp': timestamp, 'X-EZiL-Signature': signAiGatewayBody(input.secret, timestamp, rawBody) }, body: rawBody,
            });
            if (response.ok) return { status: 'ok' };
            if (response.status === 409 || response.status === 404) {
                const body = await response.json().catch(() => null);
                const code = body?.error?.code ?? body?.code;
                if (response.status === 404 && code === 'account_not_found') {
                    return { status: 'retryable', reason: 'account_not_found' };
                }
                if (response.status === 409 && code === 'event_conflict') {
                    (input.log ?? console.warn)('[billing.ai] event_conflict', { entitlementId: event.entitlementId });
                    return { status: 'permanent', reason: 'event_conflict' };
                }
            }
            return { status: response.status >= 500 ? 'retryable' : 'permanent', reason: `http_${response.status}` };
        });
    } catch {
        return { status: 'retryable', reason: 'transport_unavailable' };
    }
}
