'use client';

import { useEffect, useRef, useState } from 'react';
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
    computer,
    readOnly = false,
    onDelete,
    isDeleting = false,
}: {
    computer: ComputerRowData;
    /** An older computer: shown with Delete only, never opened from here. */
    readOnly?: boolean;
    /** Opens the delete confirmation. */
    onDelete?: () => void;
    /** True while this row's delete mutation is in flight. */
    isDeleting?: boolean;
}) {
    const router = useRouter();
    const navigatingRef = useRef(false);
    const handleOpen = () => {
        if (readOnly || navigatingRef.current) return;
        navigatingRef.current = true;
        router.push(`${Routes.COMPUTER}/${computer.id}`);
    };
    const details = (
        <div className="min-w-0">
            <div className="truncate text-sm font-medium text-offwhite">{computer.name}</div>
            <div className="text-xs text-gray-500">
                Active {timeAgo(computer.lastOpenedAt ?? computer.createdAt)}
            </div>
        </div>
    );
    const menu = onDelete ? <RowMenu computerName={computer.name} disabled={isDeleting} onDelete={onDelete} /> : null;

    if (readOnly) {
        return (
            <div
                data-testid="computer-row-older"
                className="flex h-20 w-full items-center justify-between rounded-lg border border-white/10 bg-charcoal-light/50 px-5"
            >
                {details}
                <div className="flex shrink-0 items-center gap-2">
                    {isDeleting ? <span className="text-xs text-gray-400">Deleting…</span> : null}
                    {menu}
                </div>
            </div>
        );
    }

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
            {details}
            <div className="flex shrink-0 items-center gap-2">
                {/* "Open" is a hover affordance; "Deleting…" is status,
                    so it stays visible whether or not the pointer is
                    over the row. */}
                <span
                    className={`rounded-full border border-white/15 bg-black/30 px-3 py-1 text-xs font-medium text-offwhite transition-opacity ${
                        isDeleting ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                >
                    {isDeleting ? 'Deleting…' : 'Open'}
                </span>
                {menu}
            </div>
        </div>
    );
}

function RowMenu({
    computerName,
    disabled,
    onDelete,
}: {
    computerName: string;
    disabled: boolean;
    onDelete: () => void;
}) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDocPointerDown = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDocPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('mousedown', onDocPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    return (
        <div
            ref={containerRef}
            className="relative"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
        >
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`More actions for ${computerName}`}
                data-testid="computer-row-menu-button"
                disabled={disabled}
                onClick={() => setOpen((v) => !v)}
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 opacity-70 transition-colors hover:bg-white/10 hover:text-offwhite focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
            >
                <DotsIcon className="h-4 w-4" />
            </button>

            {open ? (
                <div
                    role="menu"
                    className="absolute right-0 top-10 z-20 w-48 overflow-hidden rounded-md border border-white/10 bg-charcoal-light py-1 shadow-xl"
                >
                    <button
                        type="button"
                        role="menuitem"
                        data-testid="computer-row-delete"
                        onClick={() => {
                            setOpen(false);
                            onDelete();
                        }}
                        className="block w-full px-3 py-2 text-left text-sm text-red-400 transition-colors hover:bg-red-500/10"
                    >
                        Delete computer
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function DotsIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
        </svg>
    );
}
