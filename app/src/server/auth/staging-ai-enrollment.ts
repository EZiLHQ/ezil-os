import 'server-only';

import { Socket } from 'node:net';
import postgres from 'postgres';

import { aiCreditEntitlement, aiCreditOutboxItem } from '@/server/billing/ai-credits';
import { readBillingConfig } from '@/server/billing/config';

const WORK_MS = 5_000;
const CLOSE_MS = 1_000;
const CONNECT_MS = 2_000;

/**
 * The only Gateway funding origins that may enroll: staging and production. Compared with the parsed
 * origin of the configured BILLING_FUNDING_URL, exactly (render-env pins production to ai.ezil.work).
 */
const ENROLLMENT_FUNDING_ORIGINS: ReadonlySet<string> = new Set(['https://ai-staging.ezil.work', 'https://ai.ezil.work']);
/**
 * The fixed refusal vocabulary of `ezil_works.enroll_ai_member(uuid,text)` (gw-ui
 * 20_enroll_members.sql returns `{ok:false, error}` with exactly these codes). Any other
 * result is logged as `unknown_refusal`; result text is never echoed.
 */
const SQL_REFUSALS: ReadonlySet<string> = new Set([
    'user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned', 'user_deleted', 'anonymous_user', 'public_id_collision',
]);
type Stage = 'config' | 'connect' | 'role' | 'probe' | 'enroll' | 'enqueue' | 'done';

class EnrollFailure extends Error {
    constructor(readonly code: string) { super(code); }
}

function fundingOrigin(fundingUrl: string): string | null {
    try { return new URL(fundingUrl).origin; } catch { return null; }
}

type SocketAddress = { host: string[]; port: number[]; path?: string };

/**
 * Called only after linking an identity whose Auth0 ID token has been verified. Best effort: never
 * throws, and writes exactly one coded `ai-enroll` line per attempt (fixed codes only: never ids,
 * the subject, URLs, database/provider text or credentials).
 */
export async function enrollStagingAiMember(authUserId: string, verifiedAuth0Sub: string): Promise<void> {
    let client: postgres.Sql | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let timedOut = false;
    let stage: Stage = 'config';
    let code: string | null = null;
    let failedAt: Stage = 'done';
    const sockets = new Set<Socket>();
    const deadline = performance.now() + WORK_MS;
    const unavailable = () => new Error('staging_enrollment_unavailable');
    const assertActive = () => {
        if (stopped || performance.now() >= deadline) throw unavailable();
    };

    // postgres.js end({timeout:0}) rejects its queue but can leave a connecting
    // socket alive. Own the transports as well; never close the shared app pool.
    function destroySockets() {
        for (const socket of sockets) socket.destroy();
    }
    function openSocket({ host: [host], port: [port], path }: SocketAddress): Promise<Socket> {
        assertActive(); // Also refuses any driver reconnect scheduled before shutdown.
        // A reconnect would lose BEGIN/SET LOCAL ROLE. Never resume this unit of
        // work on a fresh session with the original app privileges.
        if (sockets.size !== 0) throw unavailable();
        const socket = new Socket() as Socket & { host: string; port: number };
        socket.host = host; // Preserve the driver's TLS SNI/verification behavior.
        socket.port = port;
        sockets.add(socket);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { reject(unavailable()); socket.destroy(); }, CONNECT_MS);
            const finish = () => clearTimeout(timer);
            socket.once('error', error => { finish(); reject(error); });
            socket.once('close', () => { finish(); reject(unavailable()); });
            socket.once('connect', () => {
                finish();
                try { assertActive(); resolve(socket); }
                catch (error) { reject(error); socket.destroy(); }
            });
            if (path) socket.connect(path);
            else socket.connect(port, host);
        });
    }

    try {
        // Enroll only where the AI outbox can deliver: the funding URL and its HMAC secret, on an
        // allowed origin, and the existing database URL. No client is opened otherwise.
        const { fundingUrl, fundingHmacSecret } = readBillingConfig();
        const databaseUrl = process.env.SUPABASE_DATABASE_URL;
        if (!fundingUrl || !fundingHmacSecret || !databaseUrl) throw new EnrollFailure('disabled');
        const origin = fundingOrigin(fundingUrl);
        if (origin === null || !ENROLLMENT_FUNDING_ORIGINS.has(origin)) throw new EnrollFailure('origin_refused');
        stage = 'connect';

        // One invocation, one client, no shared acquisition queue. The socket
        // option is supported by postgres.js but absent from its bundled types.
        const options = {
            max: 1, max_pipeline: 1, prepare: false, fetch_types: false,
            connect_timeout: CONNECT_MS / 1_000, idle_timeout: 1,
            onnotice: () => {}, socket: openSocket,
        };
        client = postgres(databaseUrl, options);
        const ownedClient = client;
        async function query<T extends postgres.Row[] = postgres.Row[]>(statement: string, parameters: string[] = []) {
            assertActive();
            const rows = await ownedClient.unsafe<T>(statement, parameters);
            assertActive(); // No continuation may dispatch SQL after the deadline.
            return rows;
        }
        async function transaction<T>(work: () => Promise<T>): Promise<T> {
            await query('begin');
            try {
                await query("set local statement_timeout = '3000ms'");
                const value = await work();
                await query('commit');
                return value;
            } catch (error) {
                // A lost/deadline-closed socket rolls back at the server. While
                // still active, explicitly roll back SET LOCAL ROLE on errors.
                await query('rollback').catch(() => {});
                throw error;
            }
        }
        async function enrollAndEnqueue() {
            const enrollment = await transaction(async () => {
                stage = 'role';
                await query('set local role ezil_os_ai_enroller');
                stage = 'probe';
                const callers = await query<{ allowed: boolean }[]>(`
                    select exists (
                        select 1 from pg_catalog.pg_roles r
                        join pg_catalog.pg_proc p
                            on p.oid = pg_catalog.to_regprocedure('ezil_works.enroll_ai_member(uuid,text)')
                        cross join lateral pg_catalog.aclexplode(p.proacl) a
                        where r.rolname = current_user and r.rolname = 'ezil_os_ai_enroller'
                            and not (r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolcanlogin)
                            and r.oid <> p.proowner
                            and a.grantee = r.oid and a.privilege_type = 'EXECUTE'
                    ) as allowed
                `);
                if (callers[0]?.allowed !== true) throw new EnrollFailure('probe_failed');
                stage = 'enroll';
                // G4 owns confirmation, exact subject binding, bans/deletion/
                // anonymous checks and unchanged member role/public ID/suspension.
                const rows = await query<{ enrollment: { ok?: unknown; error?: unknown } | null }[]>(
                    'select ezil_works.enroll_ai_member($1::uuid, $2::text) as enrollment',
                    [authUserId, verifiedAuth0Sub],
                );
                return rows[0]?.enrollment;
            });
            if (enrollment?.ok !== true) {
                const refusal = enrollment?.ok === false && typeof enrollment.error === 'string' ? enrollment.error : '';
                throw new EnrollFailure(SQL_REFUSALS.has(refusal) ? refusal : 'unknown_refusal');
            }

            // COMMIT reset the local role. Use the original app privileges on
            // this same owned client; enqueue failure preserves the enrollment.
            stage = 'enqueue';
            const entitlement = aiCreditEntitlement({
                userId: authUserId, sku: 'free_v3', subscriptionId: null,
                periodStart: new Date(), periodEnd: null, invoiceId: null,
            });
            const item = aiCreditOutboxItem(authUserId, entitlement, 'grant', null);
            await transaction(async () => {
                // Same unique event_key and conflict policy as BillingStore.
                await query(`insert into public.ezil_billing_outbox (event_key, user_id, kind, payload)
                    values ($1, $2::uuid, $3, $4::jsonb) on conflict do nothing`,
                [item.eventKey, item.userId, item.kind, JSON.stringify(item.payload)]);
            });
        }

        const expired = new Promise<never>((_, reject) => {
            deadlineTimer = setTimeout(() => {
                stopped = true;
                timedOut = true;
                destroySockets();
                reject(unavailable());
            }, Math.max(0, deadline - performance.now()));
        });
        await Promise.race([enrollAndEnqueue(), expired]);
    } catch (error) {
        // Never log database/provider detail, identity values or credentials: only a fixed code.
        code = failureCode(error, stage, timedOut);
        failedAt = stage; // Frozen: a refused late continuation cannot relabel it.
    } finally {
        stopped = true;
        clearTimeout(deadlineTimer);
        // Stop the transports synchronously before awaiting cleanup. Even if
        // shutdown acknowledgment stalls, queued callbacks cannot send more SQL.
        const closed = [...sockets].map(socket => new Promise<void>(resolve => {
            if (socket.closed) resolve();
            else socket.once('close', resolve);
        }));
        destroySockets();
        if (client) {
            let closeTimer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    Promise.allSettled([Promise.resolve().then(() => client!.end({ timeout: 0 })), ...closed]),
                    new Promise<void>(resolve => { closeTimer = setTimeout(resolve, CLOSE_MS); }),
                ]);
            } finally { clearTimeout(closeTimer); }
        }
    }
    const line = JSON.stringify({ event: 'ai-enroll', source: 'auth0', stage: failedAt, code });
    if (code === null) console.info(line);
    else console.warn(line);
}

function failureCode(error: unknown, stage: Stage, timedOut: boolean): string {
    if (timedOut) return 'timeout';
    if (error instanceof EnrollFailure) return error.code;
    switch (stage) {
        case 'config': return 'disabled';
        case 'connect': return 'connect_failed';
        case 'role': return 'set_role_failed';
        case 'probe': return 'probe_failed';
        case 'enqueue': return 'enqueue_failed';
        // A thrown enrollment call or its COMMIT: the member's state is unknown.
        default: return 'unknown_refusal';
    }
}
