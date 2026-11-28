'use client';

import React, { useEffect, useState } from 'react';

const checking = 'Checking your payment…';
const unconfirmed = 'Payment confirmation is pending. Your plan updates after payment is confirmed.';
// Before the server has said what this session bought, and for a top-up, nothing here may mention a plan.
const unclassified = 'Payment confirmation is pending.';
const topupUnconfirmed = 'Payment confirmation is pending. Your AI credits update after payment is confirmed.';
type View = { sessionId: string; message: string; canCheckAgain: boolean };
type TopupRead = {
    status: 'pending' | 'complete' | 'expired';
    paymentStatus: 'paid' | 'unpaid' | 'no_payment_required' | null;
    fulfillment: 'awaiting_payment' | 'processing' | 'credited' | 'review';
    credits?: unknown;
};

function isTopupRead(value: unknown): value is TopupRead {
    if (!value || typeof value !== 'object') return false;
    const read = value as Record<string, unknown>;
    return typeof read.status === 'string' && ['pending', 'complete', 'expired'].includes(read.status)
        && (read.paymentStatus === null || typeof read.paymentStatus === 'string'
            && ['paid', 'unpaid', 'no_payment_required'].includes(read.paymentStatus))
        && typeof read.fulfillment === 'string' && ['awaiting_payment', 'processing', 'credited', 'review'].includes(read.fulfillment);
}

const balanceUnavailable = ' Check your AI credits in Billing.';
const topupDeadline = "Payment received, but we couldn't confirm your AI credits yet. You don't need to pay again. Check Settings → Billing for your balance, and contact support if the credits don't appear.";

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
        let lastMessage = unclassified;
        let kind: 'unknown' | 'topup' | 'subscription' = 'unknown';
        let topupPaid = false;
        let creditsAdded: string | null = null;
        // A free-month checkout whose plan a summary has not confirmed yet: neutral from then on, never "starting"
        // for a return link opened long after (the summary is the authority).
        let confirming = false;
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        const deadline = setTimeout(() => {
            if (creditsAdded) {
                finish(creditsAdded + balanceUnavailable);
                return;
            }
            stopped = true;
            controller.abort();
            clearTimeout(pollTimer);
            setView({ sessionId, message: kind === 'topup' && topupPaid ? topupDeadline
                : `${lastMessage} Check Settings → Billing for updates.`, canCheckAgain: true });
        }, 60_000);
        function finish(message: string) {
            stopped = true;
            clearTimeout(deadline);
            clearTimeout(pollTimer);
            controller.abort();
            setView({ sessionId, message, canCheckAgain: false });
        }
        async function query(procedure: 'checkoutStatus' | 'topupStatus' | 'summary') {
            const input = procedure !== 'summary'
                ? `?input=${encodeURIComponent(JSON.stringify({ json: { sessionId } }))}` : '';
            // Same-origin cookies preserve the existing authenticated caller.
            // checkoutStatus validates ownership before returning its SKU.
            const response = await fetch(`/api/trpc/billing.${procedure}${input}`, {
                signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
            });
            if (!response.ok) {
                if (procedure === 'topupStatus' && kind === 'unknown' && [400, 404].includes(response.status)) {
                    const body = await response.json();
                    const error = body?.error?.json ?? body?.error;
                    if (error?.message === 'unknown_checkout' && (response.status === 404 && error?.data?.code === 'NOT_FOUND'
                        || response.status === 400 && error?.data?.code === 'BAD_REQUEST')) return null;
                }
                throw new Error('Could not check billing.');
            }
            const body = await response.json();
            if (body?.error || !body?.result?.data?.json) throw new Error('Could not check billing.');
            return body.result.data.json;
        }
        async function showTopup(topup: TopupRead) {
            if (topup.paymentStatus === 'paid') topupPaid = true;
            if (topup.status === 'expired') {
                finish('This checkout expired before payment, so you were not charged. Return to Billing to try again.');
                return;
            }
            if (topup.status !== 'complete') lastMessage = topupUnconfirmed;
            else if (topup.paymentStatus !== 'paid') {
                lastMessage = 'Your payment is processing. Bank payments can take a few days. Your AI credits update after payment is confirmed.';
            } else if (topup.fulfillment === 'review') {
                finish("Payment received, but your credits couldn't be added automatically. You don't need to pay again. Contact support if they don't appear soon.");
                return;
            } else if (topup.fulfillment === 'credited') {
                creditsAdded = typeof topup.credits === 'number' && Number.isSafeInteger(topup.credits) && topup.credits > 0
                    ? `${topup.credits.toLocaleString('en-US')} AI credits added.` : 'Your AI credits were added.';
                setView({ sessionId, message: creditsAdded, canCheckAgain: false });
                let balance = balanceUnavailable;
                try {
                    const summary = await query('summary');
                    const micro = summary?.ai?.account?.remainingMicro;
                    if (typeof micro === 'string' && micro.length > 0 && !/\D/.test(micro)) {
                        balance = ` Your balance is now ${(BigInt(micro) / BigInt(1_000_000)).toLocaleString('en-US')} credits.`;
                    }
                } catch {
                    // Delivery is already confirmed; an unavailable balance must not undo it.
                }
                if (!stopped) finish(creditsAdded + balance);
                return;
            } else lastMessage = 'Payment received. Adding your AI credits…';
            setView({ sessionId, message: lastMessage, canCheckAgain: false });
        }
        async function poll() {
            try {
                if (kind !== 'subscription') {
                    const topup = await query('topupStatus');
                    if (stopped) return;
                    // Only the server's explicit refusal selects the existing plan flow for this attempt.
                    if (kind === 'unknown' && topup === null) {
                        kind = 'subscription';
                        lastMessage = unconfirmed;
                    }
                    else {
                        if (!isTopupRead(topup)) throw new Error('Could not check billing.');
                        kind = 'topup';
                        await showTopup(topup);
                        if (!stopped) pollTimer = setTimeout(poll, 2000);
                        return;
                    }
                }
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
                if (!stopped) setView({ sessionId, message: `${kind === 'unknown' ? '' : `${lastMessage} `}We could not check for updates right now. We’ll keep checking.`, canCheckAgain: false });
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
