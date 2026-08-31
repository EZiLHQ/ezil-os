/** Everything this client throws. */
export class EzilError extends Error {
    /** tRPC error code, e.g. `UNAUTHORIZED`, `NOT_FOUND`, `BAD_REQUEST`. `null` for transport failures. */
    readonly code: string | null;
    /** HTTP status, when there was a response. */
    readonly status: number | null;
    /** The procedure being called, e.g. `computer.list`. */
    readonly path: string | null;

    constructor(
        message: string,
        opts: { code?: string | null; status?: number | null; path?: string | null; cause?: unknown } = {},
    ) {
        super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
        this.name = 'EzilError';
        this.code = opts.code ?? null;
        this.status = opts.status ?? null;
        this.path = opts.path ?? null;
    }

    /**
     * True when the call failed because the caller is not authenticated.
     *
     * Worth handling explicitly: the usual cause is an expired Supabase access
     * token, which is recoverable by refreshing it, not by retrying the same
     * call.
     */
    get isUnauthorized(): boolean {
        return this.code === 'UNAUTHORIZED' || this.status === 401;
    }

    /** True when the computer does not exist, is soft-deleted, or belongs to someone else. */
    get isNotFound(): boolean {
        return this.code === 'NOT_FOUND' || this.status === 404;
    }
}
