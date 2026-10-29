import 'server-only';

import { Socket } from 'node:net';
import postgres from 'postgres';

import { AI_CREDIT_PROTOCOL, aiCreditEntitlement, aiCreditOutboxItem } from '@/server/billing/ai-credits';
import { AI_CREDIT_KICK_SQL } from '@/server/billing/ai-credit-outbox-store';
import { readBillingConfig } from '@/server/billing/config';

const WORK_MS = 5_000;
const CLOSE_MS = 1_000;
const CONNECT_MS = 2_000;

/**
 * The fixed refusal vocabulary of `ezil_works.enroll_ai_member(uuid,text)`: gw-ui
 * scripts/os-staging/sql/20_enroll_members.sql (41cc53c, lines 62-97) returns `{ok:false, error}`
 * with exactly these codes. Any other result maps to `unknown_refusal`.
 */
export const AI_ENROLL_SQL_REFUSALS = [
    'user_not_found', 'email_unconfirmed', 'subject_mismatch', 'user_banned', 'user_deleted', 'anonymous_user', 'public_id_collision',
] as const;
/** OS-side failure codes: install/transport problems, not the member's eligibility. */
export const AI_ENROLL_UNAVAILABLE = ['set_role_failed', 'probe_failed', 'timeout', 'connect_failed', 'enqueue_failed', 'disabled'] as const;
export type AiEnrollRefusal = typeof AI_ENROLL_SQL_REFUSALS[number] | 'unknown_refusal';
export type AiEnrollCode = AiEnrollRefusal | typeof AI_ENROLL_UNAVAILABLE[number];
export type AiEnrollSource = 'auth0' | 'outbox';
export type AiEnrollResult = { ok: true } | { ok: false; code: AiEnrollCode };
type Stage = 'config' | 'connect' | 'role' | 'probe' | 'enroll' | 'enqueue' | 'done';

const SQL_REFUSALS: ReadonlySet<string> = new Set(AI_ENROLL_SQL_REFUSALS);
export const isAiEnrollRefusal = (code: AiEnrollCode): code is AiEnrollRefusal => SQL_REFUSALS.has(code) || code === 'unknown_refusal';

/** The staging-only gate (no client is opened otherwise): the exact ai-staging funding origin and the existing DB URL. */
export function aiEnrollmentConfigured(): boolean {
    try {
        const { fundingUrl } = readBillingConfig();
        return Boolean(fundingUrl && new URL(fundingUrl).origin === 'https://ai-staging.ezil.work' && process.env.SUPABASE_DATABASE_URL);
    } catch {
        return false;
    }
}

class EnrollFailure extends Error {
    constructor(readonly code: AiEnrollCode) { super(code); }
}

type SocketAddress = { host: string[]; port: number[]; path?: string };

/**
 * Enrolls the OS user as an AI Gateway member (no grant, no kick). `sub` must be the user's Auth0
 * subject: freshly verified at sign-in, or the stored `app_metadata.auth0_sub` (round 5 D1; the SQL
 * function re-checks it against the auth user). Never throws; logs one coded `ai-enroll` line.
 */
export function enrollAiMember(authUserId: string, sub: string, source: AiEnrollSource): Promise<AiEnrollResult> {
    return runEnrollment(authUserId, sub, source, false);
}

/**
 * Sign-in enrollment, called only after linking an identity whose Auth0 ID token has been verified:
 * enrolls, then (same owned client, app privileges) enqueues the Free receipt and kicks this user's
 * outbox rows that wait on the AI account so they deliver on the next sweep.
 */
export function enrollStagingAiMember(authUserId: string, verifiedAuth0Sub: string): Promise<AiEnrollResult> {
    return runEnrollment(authUserId, verifiedAuth0Sub, 'auth0', true);
}

async function runEnrollment(authUserId: string, sub: string, source: AiEnrollSource, afterSignIn: boolean): Promise<AiEnrollResult> {
    let client: postgres.Sql | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let timedOut = false;
    let stage: Stage = 'config';
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

    let result: AiEnrollResult;
    try {
        if (!aiEnrollmentConfigured()) throw new EnrollFailure('disabled');
        const databaseUrl = process.env.SUPABASE_DATABASE_URL!;
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
        async function enroll() {
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
                    [authUserId, sub],
                );
                return rows[0]?.enrollment;
            });
            if (enrollment?.ok !== true) {
                const error = enrollment?.ok === false && typeof enrollment.error === 'string' ? enrollment.error : '';
                throw new EnrollFailure(SQL_REFUSALS.has(error) ? error as AiEnrollRefusal : 'unknown_refusal');
            }
            if (!afterSignIn) return;

            // COMMIT reset the local role. Use the original app privileges on
            // this same owned client; enqueue failure preserves the enrollment.
            stage = 'enqueue';
            const now = new Date();
            const entitlement = aiCreditEntitlement({
                userId: authUserId, sku: 'free_v3', subscriptionId: null,
                periodStart: now, periodEnd: null, invoiceId: null,
            });
            const item = aiCreditOutboxItem(authUserId, entitlement, 'grant', null);
            await transaction(async () => {
                // Same unique event_key and conflict policy as BillingStore.
                await query(`insert into public.ezil_billing_outbox (event_key, user_id, kind, payload)
                    values ($1, $2::uuid, $3, $4::jsonb) on conflict do nothing`,
                [item.eventKey, item.userId, item.kind, JSON.stringify(item.payload)]);
                await query(AI_CREDIT_KICK_SQL, [authUserId, String(now.getTime()), AI_CREDIT_PROTOCOL]);
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
        stage = 'done';
        result = { ok: true };
    } catch (error) {
        result = { ok: false, code: failureCode(error, stage, timedOut) };
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
    const line = JSON.stringify({ event: 'ai-enroll', source, stage, code: result.ok ? null : result.code });
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
        // A thrown function call or enroll COMMIT: the member state is unknown, not an install problem.
        default: return 'unknown_refusal';
    }
}
