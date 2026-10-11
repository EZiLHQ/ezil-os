'use client';

import { useEffect, useState } from 'react';

const processing = 'Payment processing…';
const delayed = "Still processing — you'll see it in Settings → Billing shortly.";

/** Checkout is a receipt only; the webhook remains responsible for applying the plan. */
export function CheckoutStatus({ sessionId }: { sessionId: string }) {
    const [message, setMessage] = useState(processing);
    useEffect(() => {
        const controller = new AbortController();
        let stopped = false;
        let pollTimer: ReturnType<typeof setTimeout>;
        const deadline = setTimeout(() => {
            stopped = true;
            controller.abort();
            clearTimeout(pollTimer);
            setMessage(delayed);
        }, 60_000);
        async function poll() {
            try {
                const input = encodeURIComponent(JSON.stringify({ json: { sessionId } }));
                const response = await fetch(`/api/trpc/billing.checkoutStatus?input=${input}`, {
                    signal: controller.signal, cache: 'no-store',
                });
                const body = await response.json();
                if (stopped) return;
                const status = response.ok ? body?.result?.data?.json?.status : undefined;
                if (status === 'complete' || status === 'expired') {
                    stopped = true;
                    clearTimeout(deadline);
                    setMessage(status === 'complete' ? "You're on EZiL Pro" : 'This checkout expired');
                    return;
                }
            } catch {
                // A transient read failure does not change payment state.
            }
            if (!stopped) pollTimer = setTimeout(poll, 2000);
        }
        void poll();
        return () => {
            stopped = true;
            controller.abort();
            clearTimeout(deadline);
            clearTimeout(pollTimer);
        };
    }, [sessionId]);
    return <h1 aria-live="polite" className="text-center text-xl">{message}</h1>;
}
