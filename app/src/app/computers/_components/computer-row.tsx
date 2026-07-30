'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';

import { Routes } from '@/utils/constants';

export interface ComputerRowData {
    id: string;
    name: string;
    lastOpenedAt: string | Date | null;
    createdAt: string | Date;
}

/** Relative time formatter — "just now" / "5m" / "3h" / "2d" / falls back to a date. */
function timeAgo(input: string | Date): string {
    const date = typeof input === 'string' ? new Date(input) : input;
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return date.toLocaleDateString();
}

/**
 * A single row in the always-2-row `/computers` list. Filled and empty
 * slots share this one component so they render in the EXACT same shape
 * (height, padding, layout) — only the content inside differs. This is a
 * deliberate departure from EBuilder's wave-1 prototype (a variable-N CSS
 * grid of cards with a separate dashed "add" tile) — with the cap fixed at
 * 2, a list of exactly 2 rows communicates the limit structurally instead
 * of via a counter or a disabled state that pops in and out.
 */
export function ComputerRow({
    slot,
    computer,
    onCreate,
    isCreating,
}: {
    slot: number;
    computer?: ComputerRowData;
    onCreate: () => void;
    isCreating: boolean;
}) {
    const router = useRouter();
    const navigatingRef = useRef(false);

    if (computer) {
        const handleOpen = () => {
            if (navigatingRef.current) return;
            navigatingRef.current = true;
            router.push(`${Routes.COMPUTER}/${computer.id}`);
        };

        return (
            <div
                role="button"
                tabIndex={0}
                data-testid="computer-row"
                onClick={handleOpen}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleOpen();
                    }
                }}
                className="group flex h-20 w-full cursor-pointer items-center justify-between rounded-lg border border-white/10 bg-charcoal-light px-5 transition-colors hover:border-teal"
            >
                <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-black/30 text-xs font-medium text-gray-400">
                        {slot}
                    </span>
                    <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-offwhite">{computer.name}</div>
                        <div className="text-xs text-gray-500">
                            Active {timeAgo(computer.lastOpenedAt ?? computer.createdAt)}
                        </div>
                    </div>
                </div>
                <span className="rounded-full border border-white/15 bg-black/30 px-3 py-1 text-xs font-medium text-offwhite opacity-0 transition-opacity group-hover:opacity-100">
                    Open
                </span>
            </div>
        );
    }

    return (
        <button
            type="button"
            onClick={onCreate}
            disabled={isCreating}
            data-testid="computer-row-empty"
            className="flex h-20 w-full items-center justify-between rounded-lg border border-dashed border-white/15 px-5 text-left transition-colors hover:border-teal disabled:opacity-60"
        >
            <div className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-black/20 text-xs font-medium text-gray-500">
                    {slot}
                </span>
                <span className="text-sm font-medium text-gray-400">
                    {isCreating ? 'Creating…' : 'New computer'}
                </span>
            </div>
            <PlusIcon className="h-4 w-4 text-gray-500" />
        </button>
    );
}

function PlusIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
    );
}
