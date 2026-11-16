import { redirect } from 'next/navigation';
import { db } from '@/server/db';
import { createClient } from '@/utils/supabase/server';
import { isTelemetryAdmin } from '@/server/telemetry/admin';
import { queryTraces } from '@/server/ai-traces/admin';
import { TraceTable } from './view';
export const dynamic = 'force-dynamic';
export default async function AiTracesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const { data: { user } } = await (await createClient()).auth.getUser();
    const allowList = process.env.TELEMETRY_ADMIN_EMAILS;
    if (!user || !isTelemetryAdmin(user.email, allowList)) redirect('/login');
    const params = await searchParams;
    const scope = params.scope === 'all' ? 'all' : 'self';
    const userId = scope === 'self' ? user.id : typeof params.user === 'string' && params.user ? params.user : undefined;
    const rawPage = typeof params.page === 'string' && /^\d{1,3}$/.test(params.page) ? Number(params.page) : 0;
    const page = Math.min(100, rawPage);
    const result = await queryTraces(db, { email: user.email, allowList, userId, page });
    const link = (next: number) => `?${new URLSearchParams({ scope, ...(userId && scope === 'all' ? { user: userId } : {}), page: String(next) })}`;
    return <main className="min-h-screen w-screen overflow-auto bg-black p-8 text-offwhite">
        <h1>AI request traces</h1>
        <p>Client-reported operational metadata, retained for 7 days. Coverage and stable chat-session identity are unknown. Collection can drop records; an empty timeline does not prove no inference occurred.</p>
        <p>Latest received in this view: {result.rows[0]?.receivedAt ?? 'unknown'}. Read-heavy means any read/search without a requested write; it does not establish a stall or failed task. Gateway lifecycle and prices remain authoritative.</p>
        <form><label>Scope <select name="scope" defaultValue={scope}><option value="self">My user</option><option value="all">All users (admin)</option></select></label>{' '}
            <label>User UUID filter <input name="user" defaultValue={scope === 'all' ? userId : ''} maxLength={36} /></label>{' '}<button type="submit">Apply</button></form>
        {!result.available ? <p>Collection unavailable or filter invalid. Migration/publisher qualification may be pending.</p> : result.rows.length === 0 ? <p>No received traces in this view.</p> : <TraceTable rows={result.rows} gatewayOrigin={process.env.AI_TRACES_GATEWAY_CONSOLE_ORIGIN} />}
        <nav>{page > 0 && <a href={link(page - 1)}>Previous</a>}{' '}Page {page + 1} / 101{' '}{page < 100 && result.rows.length === 50 && <a href={link(page + 1)}>Next</a>}</nav>
    </main>;
}
