/**
 * The EZiL-OS client.
 *
 * Every method here is a `protectedProcedure` on the server, so every call acts
 * as the user whose token you supplied and can only ever see that user's
 * computers. Ownership is enforced server-side by scoped queries
 * (`liveOwnedComputer`), not by anything this client does — a client is not a
 * security boundary, and this one does not pretend to be.
 */
import { call, type CallOptions } from './transport';
import { EzilError } from './errors';
import type { Computer, DesktopStatus, DesktopUrl, EzilClientOptions } from './types';

/** Per-call escape hatches. */
export interface RequestOptions {
    signal?: AbortSignal;
}

export interface EzilClient {
    computers: {
        /** Every live computer the user owns, newest slot first. Never includes soft-deleted ones. */
        list(opts?: RequestOptions): Promise<Computer[]>;
        /** One computer by id. Throws `NOT_FOUND` if it is deleted, missing, or someone else's. */
        get(id: string, opts?: RequestOptions): Promise<Computer>;
        /**
         * Create a computer in the lowest free slot.
         * Throws when the user already holds two — the cap is a database
         * constraint, so this is a real error and not a race you can retry past.
         */
        create(input?: { name?: string }, opts?: RequestOptions): Promise<Computer>;
        /** The user's default computer, created on first call. Idempotent. */
        getOrCreateDefault(opts?: RequestOptions): Promise<Computer>;
        rename(id: string, name: string, opts?: RequestOptions): Promise<Computer>;
        /** Soft-delete, and terminate the container. The row is never hard-deleted. */
        delete(id: string, opts?: RequestOptions): Promise<{ id: string } | unknown>;
    };
    desktop: {
        /** Cheap poll. Never boots anything. */
        status(computerId: string, opts?: RequestOptions): Promise<DesktopStatus>;
        /**
         * Start or attach the desktop and mint a URL for it.
         *
         * 🔴 This is a COLD BOOT when the container is not already up — roughly
         * 22 seconds, occasionally far longer. It is also the one call whose URL
         * expires in minutes: mint it when you are about to navigate, not before.
         */
        open(computerId: string, opts?: RequestOptions): Promise<DesktopUrl>;
        /** A URL for the dev server running inside the container. Same short TTL as `open`. */
        appPreviewUrl(computerId: string, opts?: RequestOptions): Promise<DesktopUrl>;
        /** A URL for code-server inside the container. Same short TTL as `open`. */
        codeUrl(computerId: string, opts?: RequestOptions): Promise<DesktopUrl>;
        /**
         * Re-run the boot script inside the SAME container.
         *
         * 🔴 A restart does NOT pick up a new container image — the container
         * keeps the image it was created with until it actually stops. If you
         * are trying to verify an image change, this will quietly measure the
         * old one.
         */
        restart(computerId: string, opts?: RequestOptions): Promise<unknown>;
        /** Destroy the container. The computer row survives; the workspace is persisted to R2. */
        terminate(computerId: string, opts?: RequestOptions): Promise<unknown>;
    };
    /** Whether the deployment has its Cloudflare desktop provider wired up at all. */
    isConfigured(opts?: RequestOptions): Promise<unknown>;
}

const DEFAULT_TIMEOUT_MS = 300_000;

export const createEzilClient = (options: EzilClientOptions): EzilClient => {
    if (!options?.baseUrl) throw new EzilError('createEzilClient: `baseUrl` is required');
    if (!options.token) throw new EzilError('createEzilClient: `token` is required');

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
        throw new EzilError('createEzilClient: no global `fetch` — pass one via `options.fetch`');
    }

    const resolveToken = async (): Promise<string> => {
        const t = typeof options.token === 'function' ? await options.token() : options.token;
        if (!t) throw new EzilError('createEzilClient: token resolved to an empty value');
        return t;
    };

    const base = async (opts?: RequestOptions): Promise<CallOptions> => ({
        baseUrl: options.baseUrl,
        token: await resolveToken(),
        fetchImpl,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(opts?.signal ? { signal: opts.signal } : {}),
    });

    const query = async <T>(path: string, input: unknown, opts?: RequestOptions): Promise<T> =>
        call<T>('query', path, input, await base(opts));
    const mutate = async <T>(path: string, input: unknown, opts?: RequestOptions): Promise<T> =>
        call<T>('mutation', path, input, await base(opts));

    return {
        computers: {
            list: (opts) => query<Computer[]>('computer.list', undefined, opts),
            get: (id, opts) => query<Computer>('computer.get', { id }, opts),
            create: (input, opts) => mutate<Computer>('computer.create', { ...(input?.name ? { name: input.name } : {}) }, opts),
            getOrCreateDefault: (opts) => mutate<Computer>('computer.getOrCreateDefault', undefined, opts),
            rename: (id, name, opts) => mutate<Computer>('computer.rename', { id, name }, opts),
            delete: (id, opts) => mutate('computer.delete', { id }, opts),
        },
        desktop: {
            status: (computerId, opts) => query<DesktopStatus>('cloudflareGuacamole.status', { computerId }, opts),
            open: (computerId, opts) => mutate<DesktopUrl>('cloudflareGuacamole.previewUrl', { computerId }, opts),
            appPreviewUrl: (computerId, opts) => mutate<DesktopUrl>('cloudflareGuacamole.appPreviewUrl', { computerId }, opts),
            codeUrl: (computerId, opts) => mutate<DesktopUrl>('cloudflareGuacamole.codePreviewUrl', { computerId }, opts),
            restart: (computerId, opts) => mutate('cloudflareGuacamole.restartDesktop', { computerId }, opts),
            terminate: (computerId, opts) => mutate('cloudflareGuacamole.terminate', { computerId }, opts),
        },
        isConfigured: (opts) => query('cloudflareGuacamole.isConfigured', undefined, opts),
    };
};
