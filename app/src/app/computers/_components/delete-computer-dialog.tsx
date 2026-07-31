'use client';

import { useEffect, useRef } from 'react';

import { deleteComputerCopy } from '../_lib/delete-copy';

/**
 * Confirmation for deleting a computer. Hand-rolled rather than pulled from
 * a dialog library because this app carries no UI primitives package — the
 * behaviour that actually matters for a destructive confirm is small and
 * explicit here: Escape and backdrop cancel, focus lands on the SAFE action,
 * focus is restored to the trigger on close, and the confirm button is the
 * only red thing on screen.
 *
 * All wording comes from `../_lib/delete-copy.ts`, which documents what each
 * clause was verified against.
 */
export function DeleteComputerDialog({
    name,
    slot,
    isDeleting,
    onCancel,
    onConfirm,
}: {
    name: string;
    slot: number;
    isDeleting: boolean;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const copy = deleteComputerCopy({ name, slot });
    const cancelRef = useRef<HTMLButtonElement>(null);
    const previouslyFocused = useRef<Element | null>(null);

    useEffect(() => {
        previouslyFocused.current = document.activeElement;
        cancelRef.current?.focus();

        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                onCancel();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            (previouslyFocused.current as HTMLElement | null)?.focus?.();
        };
    }, [onCancel]);

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={onCancel}
            data-testid="delete-computer-backdrop"
        >
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="delete-computer-title"
                aria-describedby="delete-computer-body"
                onClick={(e) => e.stopPropagation()}
                className="w-full max-w-md rounded-xl border border-white/10 bg-charcoal-light p-6 shadow-2xl"
            >
                <h2
                    id="delete-computer-title"
                    className="text-lg font-semibold text-offwhite"
                >
                    {copy.title}
                </h2>
                <div id="delete-computer-body" className="mt-3 flex flex-col gap-2">
                    {copy.body.map((paragraph) => (
                        <p key={paragraph} className="text-sm leading-relaxed text-gray-400">
                            {paragraph}
                        </p>
                    ))}
                </div>
                <div className="mt-6 flex justify-end gap-2">
                    <button
                        ref={cancelRef}
                        type="button"
                        onClick={onCancel}
                        disabled={isDeleting}
                        className="rounded-md border border-white/15 px-4 py-2 text-sm font-medium text-offwhite transition-colors hover:bg-white/5 disabled:opacity-60"
                    >
                        {copy.cancelLabel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        disabled={isDeleting}
                        data-testid="delete-computer-confirm"
                        className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-60"
                    >
                        {isDeleting ? copy.pendingLabel : copy.confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}
