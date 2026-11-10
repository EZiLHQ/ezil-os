import type { LocalRequestCounts } from './gateway-messages';

/**
 * Where a failure arose: `local` (refused or failed on this computer; nothing was sent), `os_proxy` (the EZiL OS
 * AI proxy answered itself), `gateway` (an EZiL AI refusal relayed by the proxy), `transport` (a deadline or
 * connection failure on the way, or an HTTP error neither of them wrote) or `response` (a reply that arrived but
 * was truncated, incomplete or malformed).
 */
export type GatewayErrorOrigin = 'local' | 'os_proxy' | 'gateway' | 'transport' | 'response';

/** A gateway (or OS proxy, or local) refusal, carrying what the UI and the log need. */
export class GatewayError extends Error {
    constructor(
        message: string,
        public readonly status: number | undefined,
        public readonly code: string | undefined,
        public readonly requestId: string | undefined,
        public readonly retryAfterSeconds?: number,
        public readonly origin: GatewayErrorOrigin = 'gateway',
        /** Local refusals only: sizes, never payload text. */
        public readonly counts?: LocalRequestCounts,
    ) {
        super(message);
        this.name = 'GatewayError';
    }
}

