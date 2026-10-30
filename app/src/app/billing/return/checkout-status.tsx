'use client';

import React, { useEffect, useState } from 'react';

const checking = 'Checking your payment…';
const unconfirmed = 'Payment confirmation is pending. Your plan updates after payment is confirmed.';
type View = { sessionId: string; message: string; canCheckAgain: boolean };

/** Checkout is a receipt only; the webhook remains responsible for applying the plan. */
export function CheckoutStatus({ sessionId }: { sessionId: string }) {
    return <CheckoutStatusForSession key={sessionId} sessionId={sessionId} />;
}

function CheckoutStatusForSession({ sessionId }: { sessionId: string }) {
    const [attempt, setAttempt] = useState(0);
    const [view, setView] = useState<View>({ sessionId, message: checking, canCheckAgain: false });
    useEffect(() => {
        const controller = new AbortController();
        let stopped = false;
        let lastMessage = unconfirmed;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = setTimeout(() => {
            stopped = true;
            controller.abort();
            clearTimeout(pollTimer);
            setView({ sessionId, message: `${lastMessage} Check Settings → Billing for updates.`, canCheckAgain: true });
        }, 60_000);
        function finish(message: string) {
            stopped = true;
            clearTimeout(deadline);
            clearTimeout(pollTimer);
            controller.abort();
            setView({ sessionId, message, canCheckAgain: false });
        }
        async function query(procedure: 'checkoutStatus' | 'summary') {
            const input = procedure === 'checkoutStatus'
                ? `?input=${encodeURIComponent(JSON.stringify({ json: { sessionId } }))}` : '';
            // Same-origin cookies preserve the existing authenticated caller.
            // checkoutStatus validates ownership before returning its SKU.
            const response = await fetch(`/api/trpc/billing.${procedure}${input}`, {
                signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
            });
            if (!response.ok) throw new Error('Could not check billing.');
            const body = await response.json();
            if (body?.error || !body?.result?.data?.json) throw new Error('Could not check billing.');
            return body.result.data.json;
        }
        async function poll() {
            try {
                const checkout = await query('checkoutStatus');
                if (stopped) return;
                const status = typeof checkout === 'string' ? checkout : checkout?.status;
                if (status === 'expired') {
                    finish('This checkout expired. Return to Billing to review your plan.');
                    return;
                }
                if (status === 'complete') {
                    const expectedSku = typeof checkout.sku === 'string' && checkout.sku.trim() ? checkout.sku : null;
                    const paymentStatus = checkout.paymentStatus;
                    const receiptConfirmed = paymentStatus === 'paid' || paymentStatus === 'no_payment_required';
                    lastMessage = paymentStatus === 'paid' ? 'Payment received. Waiting for your plan to update.'
                        : paymentStatus === 'no_payment_required' ? 'No payment is required. Waiting for your plan to update.'
                        : paymentStatus === 'unpaid' ? 'Your payment is processing. Bank payments can take a few days. Your plan updates after payment is confirmed.'
                        : unconfirmed;
                    if (!expectedSku) lastMessage += ' The purchased plan could not be confirmed.';
                    setView({ sessionId, message: lastMessage, canCheckAgain: false });
                    if (expectedSku) {
                        const summary = await query('summary');
                        if (stopped) return;
                        // Payment receipt alone is insufficient. This read is the
                        // webhook-backed plan, not a client-side entitlement.
                        if (receiptConfirmed && summary?.enabled === true && summary?.plan?.sku === expectedSku
                            && ['active', 'cancels'].includes(summary.plan.status)) {
                            finish('Your plan is active.');
                            return;
                        }
                    }
                } else {
                    lastMessage = unconfirmed;
                    setView({ sessionId, message: lastMessage, canCheckAgain: false });
                }
            } catch {
                // Keep the last known receipt state without implying activation.
                if (!stopped) setView({ sessionId, message: `${lastMessage} We could not check for updates right now. We’ll keep checking.`, canCheckAgain: false });
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
    }, [sessionId, attempt]);
    const current = view.sessionId === sessionId ? view : { message: checking, canCheckAgain: false };
    return <>
        <h1 aria-live="polite" className="text-center text-xl">{current.message}</h1>
        {current.canCheckAgain && <button type="button" className="underline" onClick={() => {
            setView({ sessionId, message: checking, canCheckAgain: false });
            setAttempt(value => value + 1);
        }}>Check again</button>}
        <a href="/os?settings=billing" className="underline">Back to Billing</a>
    </>;
}
