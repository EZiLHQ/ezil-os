'use client';

import { useState } from 'react';
import { toast } from 'sonner';

import { api } from '@/trpc/react';
import { ComputerRow } from './computer-row';
import { DeleteComputerDialog } from './delete-computer-dialog';

/**
 * `/computers` — the fallback page for your computer (round 3, plan §6.1,
 * decision D6): ONE computer per person, so there are no slots and nothing
 * here creates a computer. "Your computer" is the one `/os` opens — the same
 * order `getOrCreateDefaultComputer` uses (most recently opened, then lowest
 * slot). Any other live row predates the one-computer model and is listed
 * read-only under "Older computer", with Delete only.
 *
 * Deleting sits behind the row's overflow menu rather than on the row's
 * main surface (which opens the computer), and behind a confirmation that
 * states plainly what deleting does and does not do — see
 * `../_lib/delete-copy.ts`, where every clause is tied to the code it
 * describes. This page is the escape hatch when the OS shell cannot boot.
 */
export function orderComputers<T extends { slot: number; lastOpenedAt: string | Date | null }>(rows: readonly T[]): T[] {
    const opened = (row: T) => (row.lastOpenedAt ? new Date(row.lastOpenedAt).getTime() : Number.NEGATIVE_INFINITY);
    return [...rows].sort((a, b) => opened(b) - opened(a) || a.slot - b.slot);
}

export function SelectComputers() {
    const utils = api.useUtils();
    const { data: computers, isLoading, error, refetch } = api.computer.list.useQuery();
    const { mutateAsync: deleteComputer, isPending: isDeleting } = api.computer.delete.useMutation();
    const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

    const handleDelete = async (id: string) => {
        try {
            await deleteComputer({ id });
            setConfirmingDeleteId(null);
            await utils.computer.list.invalidate();
        } catch (err) {
            const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
            if (code === 'NOT_FOUND') {
                // Already gone (another tab, or a stale list): a refresh,
                // not an error.
                setConfirmingDeleteId(null);
                await utils.computer.list.invalidate();
                return;
            }
            toast.error('Failed to delete computer. Please try again.');
        }
    };

    if (isLoading) {
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4">
                <Spinner className="h-8 w-8 text-teal" />
                <div className="text-lg text-gray-400">Loading your computers…</div>
            </div>
        );
    }

    if (error) {
        const isUnauthorized = error.data?.code === 'UNAUTHORIZED';
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-4">
                <div className="flex flex-col items-center gap-2 text-center">
                    <div className="text-2xl font-medium text-offwhite">
                        {isUnauthorized ? 'Session expired' : 'Failed to load your computers'}
                    </div>
                    <div className="text-base text-gray-400">
                        {isUnauthorized
                            ? 'Please sign in again to continue.'
                            : error.message || 'An unexpected error occurred.'}
                    </div>
                </div>
                <button
                    onClick={() => refetch()}
                    className="rounded-md border border-gray-700 px-4 py-2 text-sm text-gray-200 hover:bg-gray-800"
                >
                    Retry
                </button>
            </div>
        );
    }

    const [yours, ...older] = orderComputers(computers ?? []);
    const confirming = (computers ?? []).find((c) => c.id === confirmingDeleteId);
    const row = (computer: NonNullable<typeof yours>, readOnly: boolean) => (
        <ComputerRow
            key={computer.id}
            computer={computer}
            readOnly={readOnly}
            onDelete={() => setConfirmingDeleteId(computer.id)}
            isDeleting={isDeleting && confirmingDeleteId === computer.id}
        />
    );

    return (
        <div className="mx-auto w-full max-w-2xl px-6 py-8">
            <h1 className="mb-6 text-3xl font-semibold tracking-tight text-offwhite">Your computer</h1>
            <div className="flex flex-col gap-3">
                {yours ? (
                    row(yours, false)
                ) : (
                    <a
                        href="/os"
                        data-testid="computer-open-os"
                        className="flex h-20 w-full items-center justify-between gap-4 rounded-lg border border-white/10 px-5 text-sm text-gray-300 hover:border-teal"
                    >
                        <span>Your computer is set up the first time you open EZiL OS.</span>
                        <span className="shrink-0 font-medium text-offwhite">Open EZiL OS</span>
                    </a>
                )}
            </div>
            {older.length ? (
                <section className="mt-8" aria-labelledby="older-computers-heading">
                    <h2 id="older-computers-heading" className="mb-1 text-sm font-medium text-gray-300">Older computer</h2>
                    <p className="mb-3 text-xs text-gray-500">
                        Kept from before you had one computer. Delete it when you no longer need it.
                    </p>
                    <div className="flex flex-col gap-3">{older.map((computer) => row(computer, true))}</div>
                </section>
            ) : null}

            {confirming ? (
                <DeleteComputerDialog
                    name={confirming.name}
                    slot={confirming.slot}
                    isDeleting={isDeleting}
                    onCancel={() => {
                        if (!isDeleting) setConfirmingDeleteId(null);
                    }}
                    onConfirm={() => void handleDelete(confirming.id)}
                />
            ) : null}
        </div>
    );
}

function Spinner(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" className="animate-spin" {...props}>
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
        </svg>
    );
}
