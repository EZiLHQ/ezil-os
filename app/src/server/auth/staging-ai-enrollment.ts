import 'server-only';

import { Socket } from 'node:net';
import postgres from 'postgres';

import { aiCreditEntitlement, aiCreditOutboxItem } from '@/server/billing/ai-credits';
import { readBillingConfig } from '@/server/billing/config';

const WORK_MS = 5_000;
const CLOSE_MS = 1_000;
const CONNECT_MS = 2_000;

type SocketAddress = { host: string[]; port: number[]; path?: string };

/** Called only after linking an identity whose Auth0 ID token has been verified. */
export async function enrollStagingAiMember(authUserId: string, verifiedAuth0Sub: string): Promise<void> {
    let client: postgres.Sql | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
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
        const { fundingUrl } = readBillingConfig();
        if (!fundingUrl || new URL(fundingUrl).origin !== 'https://ai-staging.ezil.work') return;
        const databaseUrl = process.env.SUPABASE_DATABASE_URL;
        if (!databaseUrl) return;

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
                await query('set local role ezil_os_ai_enroller');
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
                if (callers[0]?.allowed !== true) return null;
                // G4 owns confirmation, exact subject binding, bans/deletion/
                // anonymous checks and unchanged member role/public ID/suspension.
                const rows = await query<{ enrollment: { ok: boolean } | null }[]>(
                    'select ezil_works.enroll_ai_member($1::uuid, $2::text) as enrollment',
                    [authUserId, verifiedAuth0Sub],
                );
                return rows[0]?.enrollment;
            });
            if (enrollment?.ok !== true) throw unavailable();

            // COMMIT reset the local role. Use the original app privileges on
            // this same owned client; enqueue failure preserves the enrollment.
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
                destroySockets();
                reject(unavailable());
            }, Math.max(0, deadline - performance.now()));
        });
        await Promise.race([enrollAndEnqueue(), expired]);
    } catch {
        // Never log database/provider detail, identity values or credentials.
        console.warn('[auth0] staging AI enrollment unavailable');
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
}
