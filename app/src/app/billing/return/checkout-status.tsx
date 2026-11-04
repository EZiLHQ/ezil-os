'use client';

import React, { useEffect, useState } from 'react';

const checking = 'Checking your payment…';
const unconfirmed = 'Payment confirmation is pending. Your plan updates after payment is confirmed.';
type View = { sessionId: string; message: string; canCheckAgain: boolean };

type Trial = { state?: unknown; endsAt?: unknown; firstChargeAt?: unknown; amountCents?: unknown };
type SummaryRead = { enabled?: unknown; plan?: { sku?: unknown; status?: unknown; trial?: unknown }; computer?: { standing?: unknown } } | null | undefined;
/** Standings in which the plan's computer is usable as a paid plan (the server's STANDING-CONTRACT). */
const PAID_ACCESS = ['paid', 'plan_ending', 'grace'];

/** "$20.00" from whole cents, or null. */
function money(cents: unknown): string | null {
    return typeof cents === 'number' && Number.isSafeInteger(cents) && cents > 0
        ? `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : null;
}

/** "Feb 27, 2027": an instant's day in the viewer's zone, or null. */
function day(iso: unknown): string | null {
    const at = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isFinite(at) ? new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(at)) : null;
}

/**
 * " First charge $20.00 from Feb 27, 2027 unless you cancel." from the server's `plan.trial`, in the viewer's zone; ''
 * when unreadable. A date, never a minute: Stripe collects the first charge about an hour after the trial end.
 */
function firstCharge(trial: Trial): string {
    const amount = money(trial.amountCents), on = day(trial.firstChargeAt);
    return trial.state === 'trialing' && amount && on ? ` First charge ${amount} from ${on} unless you cancel.` : '';
}

/**
 * What the webhook-backed summary says about this checkout's plan: a final message, or null to keep checking. The SKU
 * alone is never access: "active" needs a paid standing, and a free month is named by its own state, including an old
 * return link opened after the free month ended (Standard paused while the first payment is collected, or after it
 * failed). Never "active" for either.
 */
function confirmedMessage(summary: SummaryRead, expectedSku: string): string | null {
    if (summary?.enabled !== true || !summary.plan || summary.plan.sku !== expectedSku) return null;
    const trial = summary.plan.trial && typeof summary.plan.trial === 'object' ? summary.plan.trial as Trial : null;
    if (trial) {
        const first = money(trial.amountCents) ? `first ${money(trial.amountCents)} payment` : 'first payment';
        switch (trial.state) {
            case 'trialing': return `Your free month has started.${firstCharge(trial)}`;
            case 'ending': return day(trial.endsAt) ? `Your free month has started; it ends on ${day(trial.endsAt)} and you won't be charged.` : 'Your free month has started.';
            case 'payment_pending': return `Your free month has ended; we're collecting the ${first}. Standard is paused until it goes through.`;
            case 'payment_failed': return `Your free month has ended and the ${first} didn't go through. Standard is paused; your files are kept.`;
            default: return null;
        }
    }
    return typeof summary.plan.status === 'string' && ['active', 'cancels'].includes(summary.plan.status)
        && typeof summary.computer?.standing === 'string' && PAID_ACCESS.includes(summary.computer.standing) ? 'Your plan is active.' : null;
}

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
        // A free-month checkout whose plan a summary has not confirmed yet: neutral from then on, never "starting"
        // for a return link opened long after (the summary is the authority).
        let confirming = false;
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
                    // The server names our free-month checkout (checkoutStatus.trial); $0 today is never "paid" or
                    // "payment received". Without the flag, a subscription checkout with nothing to pay is the free month.
                    const freeMonth = paymentStatus === 'no_payment_required'
                        && (typeof checkout.trial === 'boolean' ? checkout.trial : true);
                    lastMessage = paymentStatus === 'paid' ? 'Payment received. Waiting for your plan to update.'
                        : freeMonth ? confirming ? 'We’re confirming your plan.' : 'Your free month is starting. Waiting for your plan to update.'
                        : paymentStatus === 'no_payment_required' ? 'No payment is required. Waiting for your plan to update.'
                        : paymentStatus === 'unpaid' ? 'Your payment is processing. Bank payments can take a few days. Your plan updates after payment is confirmed.'
                        : unconfirmed;
                    if (!expectedSku) lastMessage += ' The purchased plan could not be confirmed.';
                    setView({ sessionId, message: lastMessage, canCheckAgain: false });
                    if (expectedSku) {
                        const summary = await query('summary');
                        if (stopped) return;
                        // Payment receipt alone is insufficient, and so is the SKU. This read is the
                        // webhook-backed plan, not a client-side entitlement.
                        const message = receiptConfirmed ? confirmedMessage(summary, expectedSku) : null;
                        if (message) {
                            finish(message);
                            return;
                        }
                        if (freeMonth) confirming = true;
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
