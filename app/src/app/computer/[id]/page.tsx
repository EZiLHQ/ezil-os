import Link from 'next/link';

import { CloudflareGuacamoleCanvas } from '@/components/desktop/cloudflare-guacamole-canvas';
import { api } from '@/trpc/server';
import { Routes } from '@/utils/constants';
import { resolveComputerPageState } from './access';

/**
 * `/computer/[id]` — renders the EZiL OS desktop ALONE, with thin top
 * chrome only (back / name / status pill) — no editor chrome, no chat,
 * because none of that exists in this app.
 *
 * Ownership is enforced entirely by `computer.get`: it is scoped to
 * `(id, userId, deletedAt IS NULL)` server-side and throws a plain
 * `NOT_FOUND` (never a distinguishing `FORBIDDEN`) for a computer that
 * either doesn't exist or belongs to another user. That is caught by
 * `resolveComputerPageState` and rendered as a generic "not found" screen
 * — missing id, nonexistent computer, and someone else's computer all
 * collapse to the exact same render.
 *
 * `computer.touch` is called (fire-and-forget) so `computer.list` can
 * later surface "recently used" ordering — its failure must never block
 * the desktop from rendering.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computer/[id]/page.tsx`
 * (authored post-Onlook-import, listed as safe to carry). Adapted to add
 * the thin top-chrome bar (back / name / status) this repo's spec calls
 * for — the source rendered the canvas with zero chrome, since EBuilder
 * had a separate top bar elsewhere in its editor shell that this app
 * doesn't have.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const computerId = (await params).id;

    const state = await resolveComputerPageState(computerId, (id) => api.computer.get({ id }));

    if (state.status === 'not_found') {
        return <NotFound />;
    }

    const { computer } = state;

    // Stamp `lastOpenedAt`. Never blocks or fails the render.
    void api.computer.touch({ id: computer.id }).catch(() => {});

    return (
        <div className="flex h-screen w-screen flex-col overflow-hidden bg-neutral-950">
            <header className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 bg-black px-3">
                <Link
                    href={Routes.COMPUTERS}
                    className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-offwhite"
                >
                    <BackIcon className="h-3.5 w-3.5" />
                    Your computers
                </Link>
                <span className="text-xs font-medium text-offwhite">{computer.name}</span>
                <span className="flex items-center gap-1.5 rounded-full border border-teal/30 bg-teal/10 px-2 py-0.5 text-[10px] font-medium text-teal">
                    <span className="h-1.5 w-1.5 rounded-full bg-teal" />
                    Live
                </span>
            </header>
            <div className="min-h-0 flex-1">
                <CloudflareGuacamoleCanvas computerId={computer.id} sessionId={computer.id} />
            </div>
        </div>
    );
}

function NotFound() {
    return (
        <main className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-black p-4 text-center text-offwhite">
            <h1 className="text-2xl font-semibold">Computer not found</h1>
            <p className="text-gray-400">
                It may have been deleted, or it doesn&apos;t belong to your account.
            </p>
            <Link
                href={Routes.COMPUTERS}
                className="inline-flex items-center gap-2 rounded-md bg-teal px-4 py-2 text-sm font-medium text-black hover:opacity-90"
            >
                <BackIcon className="h-4 w-4" />
                Back to your computers
            </Link>
        </main>
    );
}

function BackIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
    );
}
