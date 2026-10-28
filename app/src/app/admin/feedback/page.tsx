import { notFound, redirect } from 'next/navigation';

import { env } from '@/env';
import { db } from '@/server/db';
import { isFeedbackAdmin } from '@/server/feedback/admin';
import { deleteFeedbackReport, feedbackAdminQueries, loadFeedbackList, loadFeedbackReport } from '@/server/feedback/admin-queries';
import { diagnosticsSchema } from '@/server/feedback/types';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

async function context() {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !isFeedbackAdmin(user.email, env.FEEDBACK_ADMIN_EMAILS)) notFound();
    return { user, allowList: env.FEEDBACK_ADMIN_EMAILS, ...feedbackAdminQueries(db) };
}

async function deleteReport(form: FormData) {
    'use server';
    // Re-authenticate the action; a previous page render is not authority.
    if (!await deleteFeedbackReport(form.get('id'), await context())) notFound();
    redirect('/admin/feedback');
}

/** Server-rendered, uncached, with plain links so prefetch never records a view. */
export default async function FeedbackAdminPage({ searchParams }: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const deps = await context();
    const { id } = await searchParams;
    const report = id === undefined ? null : await loadFeedbackReport(id, deps);
    if (id !== undefined && !report) notFound();
    const reports = report ? [] : await loadFeedbackList(deps);
    if (!reports) notFound();

    return (
        <div className="min-h-screen w-screen overflow-y-auto bg-black px-6 py-8 text-offwhite">
            <div className="mx-auto max-w-5xl space-y-8">
                <header>
                    <h1 className="text-xl font-semibold">Feedback review</h1>
                    <p className="mt-1 text-sm text-offwhite/60">Report views, screenshot views, and deletions are logged.</p>
                </header>
                {report ? (
                    <section className="space-y-4">
                        <a href="/admin/feedback" className="underline">All reports</a>
                        <h2 className="font-mono text-sm">{report.id}</h2>
                        <p className="text-sm">{timestamp(report.createdAt)} · {report.category} · {report.status}</p>
                        <p className="whitespace-pre-wrap break-words">{report.description}</p>
                        <p className="text-sm">Computer: {report.computerId ?? '—'}</p>
                        <p className="text-sm">Deployed commit: <span className="font-mono">{report.deploySha ?? '—'}</span></p>
                        <h3 className="font-semibold">Diagnostics</h3>
                        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(report.diagnostics, null, 2) ?? 'None'}</pre>
                        {report.hasScreenshot ? (
                            <p><a href={`/api/admin/feedback/screenshot?id=${encodeURIComponent(report.id)}`} className="underline">View screenshot</a></p>
                        ) : <p className="text-sm text-offwhite/60">No screenshot available.</p>}
                        <form action={deleteReport}>
                            <input type="hidden" name="id" value={report.id} />
                            <button type="submit" className="rounded border border-offwhite/30 px-3 py-2 text-sm">Delete report and screenshot</button>
                        </form>
                    </section>
                ) : reports.length === 0 ? <p>No reports yet.</p> : (
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[800px] text-left text-sm">
                            <thead><tr className="border-b border-offwhite/20">
                                {['Report', 'Created', 'Category', 'Description', 'Screenshot', 'Computer', 'Commit', 'Diagnostics'].map((heading) => <th key={heading} className="py-2 pr-4 font-medium">{heading}</th>)}
                            </tr></thead>
                            <tbody>{reports.map((row) => (
                                <tr key={row.id} className="border-b border-offwhite/10">
                                    <td className="py-2 pr-4 font-mono text-xs"><a href={`/admin/feedback?id=${encodeURIComponent(row.id)}`} className="underline">{row.id}</a></td>
                                    <td className="py-2 pr-4">{timestamp(row.createdAt)}</td>
                                    <td className="py-2 pr-4">{row.category}</td>
                                    <td className="max-w-xs break-words py-2 pr-4">{row.descriptionPreview}</td>
                                    <td className="py-2 pr-4">{row.hasScreenshot ? 'Yes' : 'No'}</td>
                                    <td className="py-2 pr-4 font-mono text-xs">{row.computerId ?? '—'}</td>
                                    <td className="py-2 pr-4 font-mono text-xs">{row.deploySha?.slice(0, 8) ?? '—'}</td>
                                    <td className="py-2 pr-4">{diagnosticsSummary(row.diagnostics)}</td>
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
}

function timestamp(value: Date | string): string {
    return new Date(value).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function diagnosticsSummary(value: unknown): string {
    const parsed = diagnosticsSchema.safeParse(value);
    if (!parsed.success) return 'None';
    const d = parsed.data;
    return [d.browser && `${d.browser.family} ${d.browser.major}`, d.os, d.deviceClass, d.computerStatus, d.stream?.state].filter(Boolean).join(' · ') || 'None';
}
