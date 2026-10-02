'use client';

import { useEffect, useState } from 'react';

/**
 * The lock screen's date and time, in the visitor's own locale and time zone.
 *
 * Rendered only after mount: the server does not know the visitor's time zone,
 * and a server-rendered time would disagree with the browser's on hydration.
 * The block keeps its height while empty so nothing below it moves when the
 * time appears.
 */
export function LockClock() {
    const [now, setNow] = useState<Date | null>(null);

    useEffect(() => {
        let timer: ReturnType<typeof setTimeout>;
        // Tick on the minute boundary, not every 60 s from whenever the page
        // loaded, so the clock turns over when a real clock would.
        const update = () => {
            clearTimeout(timer);
            setNow(new Date());
            timer = setTimeout(update, 60_000 - (Date.now() % 60_000));
        };
        const resume = () => {
            if (document.visibilityState === 'visible') update();
        };
        update();
        window.addEventListener('pageshow', update);
        document.addEventListener('visibilitychange', resume);
        return () => {
            clearTimeout(timer);
            window.removeEventListener('pageshow', update);
            document.removeEventListener('visibilitychange', resume);
        };
    }, []);

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
        <div className="ezil-lock-clock" aria-hidden="true">
            <p className="ezil-lock-date">{date}</p>
            <p className="ezil-lock-time">
                {time}
            </p>
        </div>
    );
}
