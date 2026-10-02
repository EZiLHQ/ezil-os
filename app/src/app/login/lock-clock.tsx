'use client';

import { useSyncExternalStore } from 'react';

/** Notifies on every minute boundary, so the clock turns over when a real one would. */
function subscribeToMinutes(notify: () => void): () => void {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
        timer = setTimeout(() => {
            notify();
            schedule();
        }, 60_000 - (Date.now() % 60_000));
    };
    schedule();
    return () => clearTimeout(timer);
}

/** The current minute. A number, so React sees no change between ticks. */
const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;

/** On the server, and on the first client render, there is no time yet. */
const noTimeYet = () => null;

/**
 * The lock screen's date and time, in the visitor's own locale and time zone.
 *
 * Empty until the page is hydrated: the server does not know the visitor's
 * time zone, and a server-rendered time would disagree with the browser's on
 * hydration. The block keeps its height while empty so nothing below it moves
 * when the time appears.
 */
export function LockClock() {
    const minute = useSyncExternalStore(subscribeToMinutes, currentMinute, noTimeYet);
    const now = minute === null ? null : new Date(minute);

    const date = now?.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    // "9:41", the way a lock screen shows it: no AM/PM marker.
    const time = now
        ? new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
            .formatToParts(now)
            .filter(part => part.type !== 'dayPeriod')
            .map(part => part.value)
            .join('')
            .trim()
        : '';

    return (
        <div className="flex min-h-[7.5rem] flex-col items-center text-center sm:min-h-[10rem]" aria-hidden="true">
            <p className="h-6 text-regular font-medium text-white/75 sm:text-lg">{date}</p>
            <p className="text-[4.75rem] leading-none font-semibold tracking-tight text-white/90 tabular-nums sm:text-[7.5rem]">
                {time}
            </p>
        </div>
    );
}
