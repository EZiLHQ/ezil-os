import { notFound, redirect } from 'next/navigation';

import { db } from '@/server/db';
import { loadNativeConsent, productionNativeConsentDeps } from '@/server/native-auth/consent';
import { nativeAuthIntentsEnabled } from '@/server/native-auth/rest';
import type { NativeAuthorityDb } from '@/server/native-session/authority';
import type { NativeSessionSupabase } from '@/server/native-session/http';
import { RETURN_URL_PARAM, Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `/native/authorize/[operationId]`: the owner's consent page for one native authorization intent.
 *
 * Normal sign-in only: a signed-out visitor goes through the ordinary login with this exact path as the
 * return URL (`safeReturnUrl` accepts it byte for byte and nothing else under `/native`). The intent is
 * read under (signed-in user, operation id), so another account sees the same "not found" as a missing
 * intent and an account switch never rebinds it. Rendering is a pure read: no proof, exchange, claim or
 * dispatch. The exact task text is shown here, to its owner, and nowhere else.
 */
export default async function Page({ params }: { params: Promise<{ operationId: string }> }) {
    const operationId = (await params).operationId;
    if (!nativeAuthIntentsEnabled(process.env) || !UUID.test(operationId)) notFound();

    const supabase = await createClient();
    const id = (await supabase.auth.getUser()).data.user?.id;
    const userId = typeof id === 'string' ? id.toLowerCase() : null;
    if (!userId) {
        redirect(`${Routes.LOGIN}?${new URLSearchParams({ [RETURN_URL_PARAM]: `${Routes.NATIVE_AUTHORIZE}/${operationId}` })}`);
    }

    const deps = productionNativeConsentDeps(db as unknown as NativeAuthorityDb, createClient as unknown as () => Promise<NativeSessionSupabase>);
    const view = await loadNativeConsent(deps, userId, operationId);
    if (!view) return <NotFound />;
    const { receipt } = view;
    const { authorization, operation } = receipt;

    return (
        <main className="flex min-h-screen w-full flex-col items-center bg-black px-4 py-10 text-offwhite">
            <div className="flex w-full max-w-2xl flex-col gap-6">
                <header className="flex flex-col gap-1">
                    <h1 className="text-2xl font-semibold">
                        {receipt.kind === 'create' ? 'Start a native coding session?' : 'Renew a native coding session?'}
                    </h1>
                    <p className="text-sm text-gray-400">
                        An MCP client (<code className="break-all">{view.clientId}</code>) asked to run this on your computer.
                        Approving lets it run exactly this request on this computer, within the budget and until the end time shown
                        under Terms. Each short-lived session credential is issued only inside those terms.
                    </p>
                </header>

                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                    <dt className="text-gray-400">Computer</dt><dd className="break-all font-mono">{receipt.computerId}</dd>
                    <dt className="text-gray-400">Session</dt><dd className="break-all font-mono">{receipt.sessionId}</dd>
                    <dt className="text-gray-400">Request</dt><dd className="break-all font-mono">{receipt.operationId}</dd>
                    <dt className="text-gray-400">Decide before</dt><dd>{authorization.expiresAt}</dd>
                </dl>

                <section className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium text-gray-400">Terms</h2>
                    {view.terms.bound ? (
                        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                            <dt className="text-gray-400">Budget</dt><dd>{credits(view.terms.bound.budgetMicro)} credits</dd>
                            <dt className="text-gray-400">Approved at</dt><dd>{view.terms.bound.initialApprovalAt.toISOString()}</dd>
                            <dt className="text-gray-400">Valid until</dt><dd>{view.terms.bound.authorizationDeadline.toISOString()}</dd>
                            <dt className="text-gray-400">Profile</dt><dd className="font-mono">{view.terms.bound.profile}</dd>
                            <dt className="text-gray-400">Policy</dt><dd className="break-all font-mono">{view.terms.bound.policyId} (epoch {view.terms.bound.epoch})</dd>
                        </dl>
                    ) : view.terms.offered ? (
                        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
                            <dt className="text-gray-400">Budget</dt><dd>{credits(view.terms.offered.budgetMicro)} credits</dd>
                            <dt className="text-gray-400">Valid for</dt><dd>{duration(view.terms.offered.ttlSeconds)} after you approve</dd>
                            <dt className="text-gray-400">Profile</dt><dd className="font-mono">ezil-native-claude-v1</dd>
                            <dt className="text-gray-400">Policy</dt><dd className="break-all font-mono">{view.terms.offered.policyId} (epoch {view.terms.offered.epoch})</dd>
                        </dl>
                    ) : (
                        <p className="text-sm text-gray-400">No terms are available on this deployment, so this request cannot be approved.</p>
                    )}
                </section>

                {view.instruction !== null && (
                    <section className="flex flex-col gap-2">
                        <h2 className="text-sm font-medium text-gray-400">Exact task</h2>
                        {/* Shown exactly as received: no trimming, wrapping changes only how it is displayed. */}
                        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-white/10 bg-neutral-950 p-3 text-sm">
                            {view.instruction}
                        </pre>
                    </section>
                )}

                {view.decidable && view.termsDigest ? (
                    <form method="post" action={`/api/native/authorize/${receipt.operationId}`} className="flex gap-3">
                        <input type="hidden" name="inputDigest" value={view.inputDigest} />
                        <input type="hidden" name="termsDigest" value={view.termsDigest} />
                        <button type="submit" name="decision" value="allow"
                            className="rounded bg-offwhite px-4 py-2 text-sm font-medium text-black hover:bg-white">
                            Allow
                        </button>
                        <button type="submit" name="decision" value="deny"
                            className="rounded border border-white/20 px-4 py-2 text-sm hover:bg-white/10">
                            Deny
                        </button>
                    </form>
                ) : (
                    <section className="flex flex-col gap-1 text-sm">
                        <p>
                            Authorization: <span className="font-medium">{authorization.state}</span>
                            {authorization.reason && <span className="text-gray-400"> ({authorization.reason})</span>}
                        </p>
                        {operation && (
                            <p>
                                Session request: <span className="font-medium">{operation.state}</span>
                                {operation.reason && <span className="text-gray-400"> ({operation.reason})</span>}
                            </p>
                        )}
                    </section>
                )}

                {view.recoveryTermsDigest && (
                    <form method="post" action={`/api/native/authorize/${receipt.operationId}`} className="flex flex-col gap-2">
                        <input type="hidden" name="inputDigest" value={view.inputDigest} />
                        <input type="hidden" name="termsDigest" value={view.recoveryTermsDigest} />
                        <p className="text-sm text-gray-400">
                            You approved this request, but it has not started on the computer. You can start it now under the same
                            approval and terms.
                        </p>
                        <button type="submit" name="decision" value="allow"
                            className="self-start rounded bg-offwhite px-4 py-2 text-sm font-medium text-black hover:bg-white">
                            Start now
                        </button>
                    </form>
                )}

                {view.terms.bound && (view.revokedAt ? (
                    <p className="text-sm text-gray-400">You stopped this AI consent at {view.revokedAt.toISOString()}. Nothing new runs under it.</p>
                ) : (
                    <form method="post" action={`/api/native/authorize/${receipt.operationId}`} className="flex flex-col gap-2">
                        <input type="hidden" name="inputDigest" value={view.inputDigest} />
                        <input type="hidden" name="authorizationId" value={view.terms.bound.authzId} />
                        <p className="text-sm text-gray-400">
                            Stopping ends this whole AI consent: no new credential, renewal or run is admitted under it. Work already
                            sent to the computer is not undone or restarted.
                        </p>
                        <button type="submit" name="decision" value="revoke"
                            className="self-start rounded border border-red-400/60 px-4 py-2 text-sm text-red-300 hover:bg-red-500/10">
                            Stop this AI consent
                        </button>
                    </form>
                ))}
            </div>
        </main>
    );
}

/** Microcredits (10^6 per credit) as an exact decimal; no floating point. */
function credits(budgetMicro: string): string {
    const micro = BigInt(budgetMicro);
    const perCredit = BigInt(1_000_000);
    const whole = micro / perCredit;
    const fraction = (micro % perCredit).toString().padStart(6, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : `${whole}`;
}

function duration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return [hours ? `${hours} h` : '', minutes ? `${minutes} min` : '', rest ? `${rest} s` : ''].filter(Boolean).join(' ');
}

function NotFound() {
    return (
        <main className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-black p-4 text-center text-offwhite">
            <h1 className="text-2xl font-semibold">Request not found</h1>
            <p className="text-gray-400">This authorization request does not exist, has been removed, or belongs to another account.</p>
        </main>
    );
}
