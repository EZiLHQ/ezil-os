import Link from 'next/link';
import { redirect } from 'next/navigation';

import { db } from '@/server/db';
import { isTelemetryAdmin } from '@/server/telemetry/admin';
import {
    bootPhaseFailureRanking,
    errorRateOverTime,
    fingerprintLeaderboard,
    fingerprintLeaderboardFromRollup,
    recentTraces,
    spikeDetection,
    traceTimeline,
} from '@/server/telemetry/queries';
import { createClient } from '@/utils/supabase/server';
import { Routes } from '@/utils/constants';
import { env } from '@/env';

/**
 * `/admin/telemetry` — a minimal, honest review page. NOT a dashboard
 * product: plain server-rendered tables answering exactly the questions the
 * design brief named (job 2 — "the owner wants to review this"), no client
 * JS beyond a plain `<a href>` link, no charts, no auto-refresh.
 *
 * Gated by `isTelemetryAdmin` (`@/server/telemetry/admin.ts`) against
 * `TELEMETRY_ADMIN_EMAILS` — fails closed: unconfigured means nobody can
 * open this, not everybody. A non-admin (or signed-out) visitor is
 * redirected to `/login` rather than shown a 403/404 that would confirm the
 * route exists; combined with RLS (service-role only on all three telemetry
 * tables — see `@/server/db/schema/telemetry.ts`), reaching real rows here
 * requires BOTH the allow-list match AND this page's own `db` import, which
 * uses the service-role connection.
 *
 * Windows are fixed at 24h (leaderboard, boot-phase ranking), 48h (error
 * rate) and 90d (the rollup leaderboard) — no filters beyond the one
 * documented exception below, on purpose: this is a look-in, not a tool.
 *
 * The ONE query param this page reads: `?trace=<correlationId>`, a drill-down
 * into `traceTimeline()` linked from every row of the "Recent app-opens"
 * table — "what happened, in order, during this one app-open or preview
 * boot" (the W1 observability plan's whole point). Never trusted as
 * anything but an opaque lookup key: `traceTimeline` parameterises it, and
 * an id that matches nothing just renders an empty timeline, not an error.
 */
export default async function TelemetryAdminPage({
    searchParams,
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const supabase = await createClient();
    const {
        data: { user },
    } = await supabase.auth.getUser();

    if (!user || !isTelemetryAdmin(user.email, env.TELEMETRY_ADMIN_EMAILS)) {
        redirect(Routes.LOGIN);
    }

    const params = await searchParams;
    const rawTrace = params.trace;
    const traceId = typeof rawTrace === 'string' && rawTrace.trim() !== '' ? rawTrace.trim() : null;

    const [leaderboard, bootPhases, errorRate, traces, spikes, rollupLeaderboard, timeline] = await Promise.all([
        fingerprintLeaderboard(db, { windowHours: 24, limit: 25 }),
        bootPhaseFailureRanking(db, 24),
        errorRateOverTime(db, { hours: 48 }),
        recentTraces(db, { limit: 50 }),
        spikeDetection(db),
        fingerprintLeaderboardFromRollup(db, { days: 90, limit: 25 }),
        traceId ? traceTimeline(db, traceId) : Promise.resolve([]),
    ]);

    const totalErrors = errorRate.reduce((sum, b) => sum + b.errors, 0);
    const peakUsersReporting = errorRate.reduce((max, b) => Math.max(max, b.usersReporting), 0);
    const bootAttempts = bootPhases[0]?.bootAttempts ?? 0;
    const bootFailures = bootPhases.reduce((sum, p) => sum + p.failures, 0);

    return (
        <div className="min-h-screen w-screen overflow-y-auto bg-black px-6 py-8 text-offwhite">
            <div className="mx-auto max-w-5xl space-y-10">
                <header>
                    <h1 className="text-xl font-semibold">Telemetry review</h1>
                    <p className="mt-1 text-sm text-offwhite/60">
                        A look-in, not a dashboard. Fixed windows, no filters, no auto-refresh — reload the page
                        for fresh numbers.
                    </p>
                </header>

                <section>
                    <h2 className="text-base font-semibold">Summary (last 24-48h)</h2>
                    <dl className="mt-3 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                        <SummaryStat label="Errors (48h)" value={totalErrors} />
                        <SummaryStat label="Peak users reporting/hr (48h)" value={peakUsersReporting} />
                        <SummaryStat label="Boot attempts (24h)" value={bootAttempts} />
                        <SummaryStat label="Boot-phase failures (24h)" value={bootFailures} />
                    </dl>
                </section>

                <section>
                    <h2 className="text-base font-semibold">Top fingerprints by distinct users (24h)</h2>
                    <p className="mt-1 text-xs text-offwhite/50">
                        &quot;How many distinct users hit this fingerprint?&quot; — muted fingerprints excluded.
                    </p>
                    {leaderboard.length === 0 ? (
                        <EmptyRow text="No errors in the last 24 hours." />
                    ) : (
                        <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                                <thead>
                                    <tr className="border-b border-offwhite/20 text-offwhite/60">
                                        <Th>Fingerprint</Th>
                                        <Th>Class</Th>
                                        <Th>Source</Th>
                                        <Th>Site</Th>
                                        <Th>Code</Th>
                                        <Th align="right">Users</Th>
                                        <Th align="right">Events</Th>
                                        <Th>Last seen</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {leaderboard.map((row) => (
                                        <tr key={row.fingerprint} className="border-b border-offwhite/10">
                                            <Td mono>{row.fingerprint}</Td>
                                            <Td>{row.eventClass}</Td>
                                            <Td>{row.source}</Td>
                                            <Td mono>{row.site}</Td>
                                            <Td mono>{row.code}</Td>
                                            <Td align="right">{row.distinctUsers}</Td>
                                            <Td align="right">{row.events}</Td>
                                            <Td>{formatTimestamp(row.lastSeen)}</Td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                <section>
                    <h2 className="text-base font-semibold">Boot-phase failure ranking (24h)</h2>
                    <p className="mt-1 text-xs text-offwhite/50">
                        Phase names are the container&apos;s own vocabulary (start-neko.sh).
                    </p>
                    {bootPhases.length === 0 ? (
                        <EmptyRow text="No boot-phase failures in the last 24 hours." />
                    ) : (
                        <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                                <thead>
                                    <tr className="border-b border-offwhite/20 text-offwhite/60">
                                        <Th>Phase</Th>
                                        <Th align="right">Failures</Th>
                                        <Th align="right">Users affected</Th>
                                        <Th align="right">% of boots</Th>
                                        <Th align="right">Avg ms before fail</Th>
                                        <Th>Most common code</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {bootPhases.map((row) => (
                                        <tr key={row.phase} className="border-b border-offwhite/10">
                                            <Td mono>{row.phase}</Td>
                                            <Td align="right">{row.failures}</Td>
                                            <Td align="right">{row.usersAffected}</Td>
                                            <Td align="right">{row.pctOfBoots ?? '—'}</Td>
                                            <Td align="right">{row.avgMsBeforeFailure ?? '—'}</Td>
                                            <Td mono>{row.mostCommonCode ?? '—'}</Td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                <section>
                    <h2 className="text-base font-semibold">Error rate by hour (48h)</h2>
                    <p className="mt-1 text-xs text-offwhite/50">
                        A zero-error hour with users reporting is a real hour, not a missing one — the join is a
                        LEFT JOIN on purpose.
                    </p>
                    <div className="mt-3 max-h-96 overflow-y-auto overflow-x-auto">
                        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
                            <thead className="sticky top-0 bg-black">
                                <tr className="border-b border-offwhite/20 text-offwhite/60">
                                    <Th>Hour</Th>
                                    <Th align="right">Errors</Th>
                                    <Th align="right">Users w/ errors</Th>
                                    <Th align="right">Users reporting</Th>
                                    <Th align="right">% affected</Th>
                                </tr>
                            </thead>
                            <tbody>
                                {errorRate
                                    .slice()
                                    .reverse()
                                    .map((row) => (
                                        <tr key={row.hour} className="border-b border-offwhite/10">
                                            <Td>{formatTimestamp(row.hour)}</Td>
                                            <Td align="right">{row.errors}</Td>
                                            <Td align="right">{row.usersWithErrors}</Td>
                                            <Td align="right">{row.usersReporting}</Td>
                                            <Td align="right">{row.pctUsersAffected ?? '—'}</Td>
                                        </tr>
                                    ))}
                            </tbody>
                        </table>
                    </div>
                </section>

                <section>
                    <h2 className="text-base font-semibold">Is anything spiking right now?</h2>
                    <p className="mt-1 text-xs text-offwhite/50">
                        Last hour vs. the same hour-of-day over the previous 7 days (from the 90-day rollup, so
                        pruned raw events don&apos;t blind this). A brand-new fingerprint needs 3+ distinct users
                        before it counts — one user with a broken extension is not an outage.
                    </p>
                    {spikes.length === 0 ? (
                        <EmptyRow text="Nothing is spiking right now." />
                    ) : (
                        <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                                <thead>
                                    <tr className="border-b border-offwhite/20 text-offwhite/60">
                                        <Th>Fingerprint</Th>
                                        <Th>Site</Th>
                                        <Th>Code</Th>
                                        <Th align="right">Users now</Th>
                                        <Th align="right">Baseline mean</Th>
                                        <Th align="right">z-score</Th>
                                        <Th>New?</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {spikes.map((row) => (
                                        <tr key={row.fingerprint} className="border-b border-offwhite/10">
                                            <Td mono>{row.fingerprint}</Td>
                                            <Td mono>{row.site}</Td>
                                            <Td mono>{row.code}</Td>
                                            <Td align="right">{row.usersNow}</Td>
                                            <Td align="right">{row.baselineMean}</Td>
                                            <Td align="right">{row.z}</Td>
                                            <Td>{row.isNew ? 'yes' : 'no'}</Td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                <section>
                    <h2 className="text-base font-semibold">Top fingerprints by distinct users (90d rollup)</h2>
                    <p className="mt-1 text-xs text-offwhite/50">
                        Same question as the 24h leaderboard above, but from the hour-rollup — exact distinct-user
                        counts beyond the raw-retention horizon, since raw events are pruned at 14 days but the
                        rollup survives 90.
                    </p>
                    {rollupLeaderboard.length === 0 ? (
                        <EmptyRow text="No errors in the last 90 days." />
                    ) : (
                        <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[420px] border-collapse text-left text-sm">
                                <thead>
                                    <tr className="border-b border-offwhite/20 text-offwhite/60">
                                        <Th>Fingerprint</Th>
                                        <Th align="right">Users</Th>
                                        <Th align="right">Events</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {rollupLeaderboard.map((row) => (
                                        <tr key={row.fingerprint} className="border-b border-offwhite/10">
                                            <Td mono>{row.fingerprint}</Td>
                                            <Td align="right">{row.distinctUsers}</Td>
                                            <Td align="right">{row.events}</Td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                <section>
                    <h2 className="text-base font-semibold">Recent app-opens</h2>
                    <p className="mt-1 text-xs text-offwhite/50">
                        One row per <code>boot_summary</code> — one per app-open (shell) or preview-boot request
                        (worker/container, once drained — see <code>/api/cron/telemetry-drain</code>). Click a row
                        to see everything that happened under its correlation id.
                    </p>
                    {traces.length === 0 ? (
                        <EmptyRow text="No app-opens recorded yet." />
                    ) : (
                        <div className="mt-3 overflow-x-auto">
                            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
                                <thead>
                                    <tr className="border-b border-offwhite/20 text-offwhite/60">
                                        <Th>Correlation id</Th>
                                        <Th>Source</Th>
                                        <Th>Site</Th>
                                        <Th>Code</Th>
                                        <Th>Outcome</Th>
                                        <Th align="right">Duration (ms)</Th>
                                        <Th>Occurred at</Th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {traces.map((row) => (
                                        <tr
                                            key={row.correlationId}
                                            className={`border-b border-offwhite/10 ${row.correlationId === traceId ? 'bg-offwhite/5' : ''}`}
                                        >
                                            <Td mono>
                                                <Link
                                                    href={`/admin/telemetry?trace=${encodeURIComponent(row.correlationId)}`}
                                                    className="underline decoration-offwhite/30 hover:decoration-offwhite"
                                                >
                                                    {row.correlationId}
                                                </Link>
                                            </Td>
                                            <Td>{row.source}</Td>
                                            <Td mono>{row.site}</Td>
                                            <Td mono>{row.code}</Td>
                                            <Td>{row.outcome}</Td>
                                            <Td align="right">{row.durationMs ?? '—'}</Td>
                                            <Td>{formatTimestamp(row.occurredAt)}</Td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </section>

                {traceId ? (
                    <section>
                        <h2 className="text-base font-semibold">
                            Trace <span className="font-mono text-offwhite/80">{traceId}</span>
                        </h2>
                        <p className="mt-1 text-xs text-offwhite/50">
                            Every event sharing this correlation id, oldest first.{' '}
                            <Link href="/admin/telemetry" className="underline decoration-offwhite/30 hover:decoration-offwhite">
                                Clear
                            </Link>
                        </p>
                        {timeline.length === 0 ? (
                            <EmptyRow text="No events found for this correlation id." />
                        ) : (
                            <div className="mt-3 overflow-x-auto">
                                <table className="w-full min-w-[760px] border-collapse text-left text-sm">
                                    <thead>
                                        <tr className="border-b border-offwhite/20 text-offwhite/60">
                                            <Th>Occurred at</Th>
                                            <Th>Class</Th>
                                            <Th>Source</Th>
                                            <Th>Site</Th>
                                            <Th>Code</Th>
                                            <Th>Outcome</Th>
                                            <Th align="right">Duration (ms)</Th>
                                            <Th>Detail</Th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {timeline.map((row, i) => (
                                            // No natural unique key on this row shape (a
                                            // trace can legitimately repeat the same
                                            // class/site/code, e.g. two boot_phase steps) —
                                            // index is stable here because `timeline` is
                                            // fetched once per render, never reordered client-side.
                                            <tr key={i} className="border-b border-offwhite/10">
                                                <Td>{formatTimestamp(row.occurredAt)}</Td>
                                                <Td mono>{row.eventClass}</Td>
                                                <Td>{row.source}</Td>
                                                <Td mono>{row.site}</Td>
                                                <Td mono>{row.code}</Td>
                                                <Td>{row.outcome}</Td>
                                                <Td align="right">{row.durationMs ?? '—'}</Td>
                                                <Td>{row.detail ?? '—'}</Td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </section>
                ) : null}
            </div>
        </div>
    );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded border border-offwhite/15 p-3">
            <dt className="text-xs text-offwhite/50">{label}</dt>
            <dd className="mt-1 text-lg font-semibold">{value.toLocaleString()}</dd>
        </div>
    );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
    return <th className={`py-2 pr-4 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</th>;
}

function Td({
    children,
    align = 'left',
    mono = false,
}: {
    children: React.ReactNode;
    align?: 'left' | 'right';
    mono?: boolean;
}) {
    return (
        <td className={`py-2 pr-4 ${align === 'right' ? 'text-right' : 'text-left'} ${mono ? 'font-mono text-xs' : ''}`}>
            {children}
        </td>
    );
}

function EmptyRow({ text }: { text: string }) {
    return <p className="mt-3 text-sm text-offwhite/50">{text}</p>;
}

function formatTimestamp(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
