'use client';

import { useEffect } from 'react';

/**
 * The host page's half of the shell's hydration handshake.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `/os` renders a document that a jQuery shell (`public/os/bundle.min.js`,
 * built from `shell/`) then takes over. React owns `<body>` and
 * `<div id="ezil-os-root">`; the shell has to write to both. If it writes to
 * either BEFORE React hydrates, React finds a tree it did not render, reports
 * a hydration mismatch (minified error #418) and REGENERATES THE WHOLE TREE —
 * deleting the entire desktop. `suppressHydrationWarning` suppresses the
 * warning, not the regeneration. MEASURED on the production build with 900ms
 * of latency on `/_next/static/chunks/**`: 4 of 5 loads ended as a blank
 * white page, unrecoverable for the rest of the session.
 *
 * So the shell waits, and this is the thing it waits for. A `useEffect` runs
 * only on the client and only after React has committed — which is exactly
 * the moment writing to React-owned DOM becomes safe.
 *
 * ── Two details that are load-bearing ───────────────────────────────────────
 * 1. NO dependency array. This fires on every commit, not just the first. If
 *    React ever does re-render the root (a hydration mismatch from some other
 *    cause, a router refresh), the shell gets told again, and
 *    `ezil.ensure_intact()` rebuilds a desktop that re-render may have wiped.
 *    A `[]` here would signal once and leave the recovery path dark.
 * 2. The flag AND the event. The shell may start before this runs (it reads
 *    the flag) or after (it hears the event); one of the two always applies,
 *    and neither ordering leaves it waiting forever.
 *
 * Renders nothing. It is a signal, not UI.
 */
export function HydrationSignal() {
    useEffect(() => {
        (window as unknown as { __EZIL_HYDRATED__?: boolean }).__EZIL_HYDRATED__ = true;
        window.dispatchEvent(new Event('ezil:hydrated'));
    });

    return null;
}
