import 'server-only';

import { Socket } from 'node:net';
import postgres from 'postgres';

import { AI_CREDIT_PROTOCOL, aiCreditEntitlement, aiCreditOutboxItem } from '@/server/billing/ai-credits';
import { AI_CREDIT_KICK_SQL } from '@/server/billing/ai-credit-outbox-store';
import { aiMemberContract } from '@/server/billing/ai-member-contract';
import { readBillingConfig } from '@/server/billing/config';

const WORK_MS = 5_000;
const CLOSE_MS = 1_000;
const CONNECT_MS = 2_000;

/**
 * Each Gateway's enrollment routine: the regprocedure its ACL probe names, and its call. Only the
 * staging (ai-staging.ezil.work) and production (ai.ezil.work) funding origins may enroll.
 */
const ENROLLMENT = {
    staging: {
        procedure: 'ezil_works.enroll_ai_member(uuid,text)',
        call: 'select ezil_works.enroll_ai_member($1::uuid, $2::text) as enrollment',
    },
    production: {
        procedure: 'ezil_ai.enroll_os_member(uuid,text)',
        call: 'select ezil_ai.enroll_os_member($1::uuid, $2::text) as enrollment',
    },
} as const;
/**
 * The fixed refusal vocabulary: `{ok:false, error}` codes of `ezil_works.enroll_ai_member` (gw-ui
 * 20_enroll_members.sql) and `ezil_ai.enroll_os_member` (Gateway 0030, which adds `invalid_identity`
 * and `source_conflict` and raises on a public-id collision). Any other result maps to
 * `unknown_refusal`; result text is never echoed.
 */
export const AI_ENROLL_SQL_REFUSALS = [
    'user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned', 'user_deleted', 'anonymous_user', 'public_id_collision',
    'invalid_identity', 'source_conflict',
] as const;
/** OS-side failure codes: install/transport/configuration problems, not the member's eligibility. */
export const AI_ENROLL_UNAVAILABLE = ['set_role_failed', 'probe_failed', 'timeout', 'connect_failed', 'enqueue_failed', 'disabled',
    'origin_refused'] as const;
export type AiEnrollRefusal = typeof AI_ENROLL_SQL_REFUSALS[number] | 'unknown_refusal';
export type AiEnrollCode = AiEnrollRefusal | typeof AI_ENROLL_UNAVAILABLE[number];
/** `auth0`: at sign-in, after the ID token was verified (also enqueues the Free receipt); `outbox`: the drain. */
export type AiEnrollSource = 'auth0' | 'outbox';
export type AiEnrollResult = { ok: true } | { ok: false; code: AiEnrollCode };
type Stage = 'config' | 'connect' | 'role' | 'probe' | 'enroll' | 'kick' | 'enqueue' | 'done';

const SQL_REFUSALS: ReadonlySet<string> = new Set(AI_ENROLL_SQL_REFUSALS);
export const isAiEnrollRefusal = (code: AiEnrollCode): code is AiEnrollRefusal => SQL_REFUSALS.has(code) || code === 'unknown_refusal';

/**
 * Enroll only where the AI outbox can deliver (no client is opened otherwise): the funding URL and its
 * HMAC secret on an allowed origin (`aiMemberContract`: ai-staging or ai.ezil.work), and the existing DB URL.
 */
export function aiEnrollmentConfigured(): boolean {
    try {
        const { fundingUrl, fundingHmacSecret } = readBillingConfig();
        return Boolean(fundingUrl && fundingHmacSecret && process.env.SUPABASE_DATABASE_URL && aiMemberContract(fundingUrl) !== null);
    } catch {
        return false;
    }
}

class EnrollFailure extends Error {
    constructor(readonly code: AiEnrollCode) { super(code); }
}

type SocketAddress = { host: string[]; port: number[]; path?: string };

/**
 * Enrolls the OS user as an AI Gateway member through the funding origin's contract, then kicks this
 * user's outbox rows that wait on the AI account. `sub` must be the user's Auth0 subject: freshly verified
 * at sign-in (`source` 'auth0', the default: the Free receipt is then enqueued too, same owned client, app
 * privileges), or the stored `app_metadata.auth0_sub` for the drain (`source` 'outbox', round 5 D1; the SQL
 * function re-checks it against the auth user). Best effort: never throws, and writes exactly one coded
 * `ai-enroll` line per attempt (fixed codes only: never ids, the subject, URLs, database/provider text or
 * credentials).
 */
export async function enrollAiMember(authUserId: string, sub: string, source: AiEnrollSource = 'auth0'): Promise<AiEnrollResult> {
    const afterSignIn = source === 'auth0';
    let client: postgres.Sql | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let timedOut = false;
    let stage: Stage = 'config';
    let failedAt: Stage = 'done';
    const sockets = new Set<Socket>();
    const deadline = performance.now() + WORK_MS;
    const unavailable = () => new Error('ai_enrollment_unavailable');
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

    let result: AiEnrollResult;
    try {
        // Enroll only where the AI outbox can deliver: the funding URL and its HMAC secret, on an
        // allowed origin, and the existing database URL. No client is opened otherwise.
        const { fundingUrl, fundingHmacSecret } = readBillingConfig();
        const databaseUrl = process.env.SUPABASE_DATABASE_URL;
        if (!fundingUrl || !fundingHmacSecret || !databaseUrl) throw new EnrollFailure('disabled');
        const contract = aiMemberContract(fundingUrl);
        if (contract === null) throw new EnrollFailure('origin_refused');
        const { procedure, call } = ENROLLMENT[contract];
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
        async function query<T extends postgres.Row[] = postgres.Row[]>(statement: string, parameters: postgres.ParameterOrJSON<never>[] = []) {
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
        async function enroll() {
            const enrollment = await transaction(async () => {
                stage = 'role';
                await query('set local role ezil_os_ai_enroller');
                stage = 'probe';
                const callers = await query<{ allowed: boolean }[]>(`
                    select exists (
                        select 1 from pg_catalog.pg_roles r
                        join pg_catalog.pg_proc p
                            on p.oid = pg_catalog.to_regprocedure('${procedure}')
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
                    call, [authUserId, sub],
                );
                return rows[0]?.enrollment;
            });
            if (enrollment?.ok !== true) {
                const refusal = enrollment?.ok === false && typeof enrollment.error === 'string' ? enrollment.error : '';
                throw new EnrollFailure(SQL_REFUSALS.has(refusal) ? refusal as AiEnrollRefusal : 'unknown_refusal');
            }
            // COMMIT reset the local role. Use the original app privileges on
            // this same owned client from here on.
            // Round 5 D1 kick: wake this user's rows waiting on the AI account (every source, so a
            // drain enrollment wakes sibling rows parked as needs_ezil_id). Its own transaction, before
            // and independent of the Free receipt, so a receipt failure never rolls it back. Best
            // effort: a failure leaves those rows on their schedule and never fails the enrollment
            // (the deadline still applies: it rejects the race on its own).
            stage = 'kick';
            const now = new Date();
            await transaction(() => query(AI_CREDIT_KICK_SQL, [authUserId, String(now.getTime()), AI_CREDIT_PROTOCOL]))
                .catch(() => {});
            if (!afterSignIn) return;

            // Enqueue failure preserves the enrollment and the kick.
            stage = 'enqueue';
            const entitlement = aiCreditEntitlement({
                userId: authUserId, sku: 'free_v3', subscriptionId: null,
                periodStart: now, periodEnd: null, invoiceId: null,
            });
            const item = aiCreditOutboxItem(authUserId, entitlement, 'grant', null);
            await transaction(async () => {
                // Same unique event_key and conflict policy as BillingStore. Bind the object: this
                // raw client serializes a jsonb parameter itself, so a JSON string would be stored
                // as a jsonb string that the outbox never claims (drizzle's pool disables that).
                await query(`insert into public.ezil_billing_outbox (event_key, user_id, kind, payload)
                    values ($1, $2::uuid, $3, $4::jsonb) on conflict do nothing`,
                [item.eventKey, item.userId, item.kind, item.payload as postgres.JSONValue]);
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
        await Promise.race([enroll(), expired]);
        result = { ok: true };
    } catch (error) {
        // Never log database/provider detail, identity values or credentials: only a fixed code.
        result = { ok: false, code: failureCode(error, stage, timedOut) };
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
    // One line per attempt. Fixed codes only: never ids, the subject, DB/provider text or credentials.
    const line = JSON.stringify({ event: 'ai-enroll', source, stage: failedAt, code: result.ok ? null : result.code });
    if (result.ok) console.info(line);
    else console.warn(line);
    return result;
}

function failureCode(error: unknown, stage: Stage, timedOut: boolean): AiEnrollCode {
    if (timedOut) return 'timeout';
    if (error instanceof EnrollFailure) return error.code;
    switch (stage) {
        case 'config': return 'disabled';
        case 'connect': return 'connect_failed';
        case 'role': return 'set_role_failed';
        case 'probe': return 'probe_failed';
        case 'enqueue': return 'enqueue_failed';
        // A thrown enrollment call or its COMMIT: the member's state is unknown, not an install problem.
        default: return 'unknown_refusal';
    }
}
