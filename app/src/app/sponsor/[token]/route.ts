import { type NextRequest, NextResponse } from 'next/server';
import { sponsorEntryAvailable } from '@/server/auth/sponsor-entry';
import { trialTerms } from '@/server/billing/v3/trial';

export const dynamic = 'force-dynamic';
/** A document route intentionally bypasses the root layout's third-party analytics on the private token URL. */
export async function GET(_request: NextRequest, context: { params: Promise<{ token: string }> }) {
    const { token } = await context.params;
    const available = await sponsorEntryAvailable(token);
    const renewal = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(trialTerms(new Date()).amountCents / 100);
    // The token is strictly base64url before interpolation; there is no client-controlled HTML, redirect or campaign ID.
    const body = available
        ? `<p class="eyebrow">Sponsored access</p><h1>One month of Standard.</h1><p>Get started with EZiL OS through this sponsor invitation.</p><p><strong>A card is required.</strong> Your Standard plan renews at ${renewal}/month (USD, before applicable tax) after the calendar-month trial unless you cancel. You will review the exact trial end and renewal terms in checkout.</p><p class="detail">Available to eligible accounts that have not already used a Standard trial. Free plan usage does not use up this trial.</p><form method="post" action="/sponsor/continue"><input type="hidden" name="token" value="${token}"><button type="submit">Continue with EZiL ID</button></form><p class="detail">Sign in or create your account, then review your offer in Billing. No payment is taken on this page.</p>`
        : '<h1>This invitation is unavailable.</h1><p>The sponsor offer may have ended. You can still sign in to EZiL OS.</p><a class="button" href="/login">Go to sign in</a>';
    return new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Sponsored Standard invitation | EZiL OS</title><style>body{margin:0;background:#f7f7f5;color:#18181b;font:16px/1.6 system-ui,sans-serif}main{box-sizing:border-box;max-width:520px;margin:8vh auto;padding:32px 24px}a{color:inherit}header{font-weight:650;margin-bottom:40px}h1{font-size:36px;line-height:1.15;letter-spacing:-1px;margin:12px 0 24px}.eyebrow{font-size:13px;color:#52525b}.detail{font-size:14px;color:#52525b}button,.button{display:block;box-sizing:border-box;width:100%;border:0;border-radius:8px;background:#18181b;color:white;padding:14px 20px;font:600 16px system-ui;text-align:center;text-decoration:none;cursor:pointer}form{margin:28px 0 16px}button:focus-visible,a:focus-visible{outline:3px solid #2563eb;outline-offset:4px}@media(max-width:540px){main{margin:3vh auto}h1{font-size:32px}}</style></head><body><main><header><a href="/">EZiL OS</a></header>${body}</main></body></html>`, {
        status: available ? 200 : 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" },
    });
}
