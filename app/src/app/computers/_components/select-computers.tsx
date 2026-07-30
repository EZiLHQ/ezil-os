'use client';

import { toast } from 'sonner';

import { api } from '@/trpc/react';
import { MAX_COMPUTERS_PER_USER } from '@/utils/constants';
import { ComputerRow } from './computer-row';

/**
 * `/computers` — always renders exactly `MAX_COMPUTERS_PER_USER` rows,
 * lowest slot first. A slot with a live computer renders it; a free slot
 * renders the SAME shape with a "New computer" affordance instead — there
 * is no separate "at cap" visual state to manage, because with only 2
 * slots ever on screen the cap is structural, not a counter.
 *
 * The limit is surfaced on the action, not proactively: nothing on this
 * page warns "you're at your limit" ahead of time — with both slots filled
 * there's simply no empty row left to click. The one edge case that IS
 * surfaced is a genuine race (two tabs both try to fill the last slot at
 * once) — the loser's `create` call gets the server's typed
 * `computer_limit_reached` error, shown as a toast on that click.
 */
export function SelectComputers() {
    const utils = api.useUtils();
    const { data: computers, isLoading, error, refetch } = api.computer.list.useQuery();
    const { mutateAsync: createComputer, isPending: isCreating } = api.computer.create.useMutation();

    const handleCreate = async () => {
        try {
            await createComputer({});
            await utils.computer.list.invalidate();
        } catch (err) {
            const code = (err as { data?: { code?: string } } | undefined)?.data?.code;
            if (code === 'FORBIDDEN') {
                toast.error("You've reached your computer limit.");
                return;
            }
            toast.error('Failed to create computer. Please try again.');
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

    const bySlot = new Map((computers ?? []).map((c) => [c.slot, c]));

    return (
        <div className="mx-auto w-full max-w-2xl px-6 py-8">
            <h1 className="mb-6 text-3xl font-semibold tracking-tight text-offwhite">Your computers</h1>
            <div className="flex flex-col gap-3">
                {Array.from({ length: MAX_COMPUTERS_PER_USER }, (_, i) => i + 1).map((slot) => (
                    <ComputerRow
                        key={slot}
                        slot={slot}
                        computer={bySlot.get(slot)}
                        onCreate={handleCreate}
                        isCreating={isCreating}
                    />
                ))}
            </div>
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
