'use client';

import { motion } from 'motion/react';

import { MAX_COMPUTERS_PER_USER } from '@/utils/constants';

/**
 * The pitch on this screen: a real Linux desktop, streamed to the browser —
 * not a preview, not a simulation of one. Deliberately understated and
 * deliberately doesn't promise a populated workspace: a brand-new computer
 * boots to a genuinely empty desktop.
 *
 * Design and copy carried from EBuilder's `ezil-login` worktree (commit
 * 912247a, "re-skinned to sell 'your computer, in your browser'") —
 * re-implemented fresh against this app's own (smaller) Tailwind theme
 * rather than copy-pasted, since the source file depends on
 * `@ezil/ui/icons` / EBuilder's design-token set that this standalone repo
 * does not carry.
 */
export function DesktopVisual() {
    return (
        <div className="relative flex h-full w-full flex-col justify-center overflow-hidden rounded-xl border border-white/10 bg-gradient-to-b from-charcoal via-charcoal to-charcoal-light p-10 lg:p-14">
            <div className="max-w-md space-y-4">
                <span className="text-mini font-medium tracking-widest text-teal uppercase">
                    EZiL OS
                </span>
                <h1 className="text-title1 leading-tight text-offwhite">
                    Your computer,
                    <br />
                    in your browser.
                </h1>
                <p className="text-regular text-gray-400">
                    A real Linux desktop, running in the cloud and streamed straight to this tab.
                    Nothing simulated — it&apos;s an actual computer with actual root access.
                </p>
            </div>

            <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.15 }}
                className="mt-10 w-full max-w-md overflow-hidden rounded-lg border border-white/10 bg-black/40 shadow-2xl shadow-black/40"
            >
                <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-3 py-2">
                    <div className="flex gap-1.5">
                        <div className="h-2.5 w-2.5 rounded-full bg-red-500/70" />
                        <div className="h-2.5 w-2.5 rounded-full bg-yellow-500/70" />
                        <div className="h-2.5 w-2.5 rounded-full bg-green-500/70" />
                    </div>
                    <div className="flex items-center gap-1.5 rounded-full border border-white/10 bg-black/30 px-2 py-0.5">
                        <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal" />
                        </span>
                        <span className="text-mini text-gray-300">Live</span>
                    </div>
                </div>
                <div className="flex h-40 items-center justify-center bg-gradient-to-br from-charcoal-light to-charcoal">
                    <span className="text-small text-gray-500">
                        Boots in seconds. Ready when you are.
                    </span>
                </div>
                <div className="flex items-center justify-between border-t border-white/10 bg-black/30 px-3 py-1.5">
                    <div className="h-2 w-16 rounded-full bg-white/10" />
                    <div className="h-2 w-10 rounded-full bg-white/10" />
                </div>
            </motion.div>

            <ul className="mt-8 space-y-2 text-small text-gray-400">
                <li className="flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-teal" />A full Linux desktop, not a
                    container preview
                </li>
                <li className="flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-teal" />
                    Up to {MAX_COMPUTERS_PER_USER} computers per account
                </li>
                <li className="flex items-center gap-2">
                    <span className="h-1 w-1 rounded-full bg-teal" />
                    Projects live as folders inside your computer
                </li>
            </ul>
        </div>
    );
}
