/**
 * Standard trial (request standard-trial-01b28d18-20261105-v1). Standard only: $0 today, the same Standard computer,
 * disk and AI credits for one calendar month, then $20/month unless cancelled. No Premium trial.
 *
 * Calendar month (explicit): the trial ends one calendar month after the server's quote instant, at the same UTC
 * time of day, in whole seconds. A day the next month lacks clamps to its last day (31 Jan → 28/29 Feb, 31 Mar →
 * 30 Apr; 29 Feb 2028 → 29 Mar 2028). The arithmetic is UTC only, so the result never depends on the viewer's or the
 * server's time zone; clients show the same instant in the viewer's zone. That instant is the first charge.
 *
 * Identity (explicit): one trial per verified person. The account (Supabase user id), its sign-in subject (the Auth0
 * `sub` when linked) and its normalized verified email are each unique in `ezil_billing_trials`. A trial, or any
 * earlier positive paid Standard/Premium/Pro period for the same account or the same normalized email, refuses.
 * The claim follows the CURRENT verified identity: a re-quote moves an unstarted claim to it, and checkout refuses a
 * quote whose subject or email no longer match. Any other account whose current email is the same person blocks too.
 * A deleted account's row stays as a tombstone (user_id null): a started trial still claims its subject and email;
 * a never-started quote of a deleted account may be reclaimed.
 *
 * Abandoned checkout (explicit): a quote claims the person's trial row for this account only. Expired or abandoned
 * checkouts never consume it: the same account may re-quote (a new end) and open a new checkout, which expires the
 * previous open session first. The claim is never released to another account or email.
 *
 * Everything here is pure; the store supplies facts and the processor enforces Stripe's state.
 */
import { AI_CREDIT_POLICY_VERSION, CATALOG_V3 } from './contract';
import type { AiCreditEntitlement } from '../ai-credits';

export const TRIAL_POLICY_VERSION = 1 as const;
export const TRIAL_SKU = 'standard_monthly_v3' as const;
/** Checkout and subscription metadata key carrying the trial row id (never an owner: ownership is the customer map). */
export const TRIAL_METADATA_KEY = 'ezil_trial' as const;
/** A quote older than this must be re-quoted before checkout, so the disclosed end stays close to one month. */
export const TRIAL_QUOTE_TTL_SECONDS = 30 * 60;
/** Immutable quote-based expiry: even the last fresh 30-minute quote leaves 90 minutes for Stripe (minimum 30 minutes). */
export const TRIAL_CHECKOUT_TTL_SECONDS = 2 * 60 * 60;

export type TrialStatus = 'quoted' | 'checkout' | 'trialing' | 'converted' | 'canceled' | 'ended' | 'payment_failed';
export const UNBOUND_TRIAL_STATUSES: readonly TrialStatus[] = ['quoted', 'checkout'];

export interface TrialRow {
    id: string;
    /** Null once the account was deleted (a tombstone claim). */
    userId: string | null;
    authSubject: string;
    emailNormalized: string;
    sku: string;
    policyVersion: number;
    status: TrialStatus;
    quotedAt: Date;
    /** The disclosed trial end and first charge of the current quote. */
    trialEnd: Date;
    checkoutSessionId: string | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    trialStart: Date | null;
    /** The owned app origin of the quote (billing/return-origin.ts): the checkout's return URLs never vary by request. */
    returnOrigin: string;
}

const whole = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

/** One calendar month later, UTC, month-end clamped, whole seconds (see the module note). */
export function addCalendarMonthUtc(at: Date): Date {
    const start = whole(at);
    if (!Number.isFinite(start.getTime())) throw new RangeError('Invalid trial instant');
    const year = start.getUTCFullYear(), month = start.getUTCMonth();
    const lastDayNextMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
    return new Date(Date.UTC(year, month + 1, Math.min(start.getUTCDate(), lastDayNextMonth),
        start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds()));
}

export interface TrialTerms {
    quotedAt: Date;
    /** Trial end = the first $20 charge, unless cancelled before it. */
    trialEnd: Date;
    amountCents: number;
    currency: 'usd';
}

export function trialTerms(now: Date): TrialTerms {
    const quotedAt = whole(now);
    return { quotedAt, trialEnd: addCalendarMonthUtc(quotedAt), amountCents: CATALOG_V3[TRIAL_SKU].priceCents, currency: 'usd' };
}

/** True while a stored quote may still open a checkout at `now`. */
export function quoteFresh(row: Pick<TrialRow, 'quotedAt'>, now: Date): boolean {
    const age = now.getTime() - row.quotedAt.getTime();
    return age >= 0 && age <= TRIAL_QUOTE_TTL_SECONDS * 1000;
}

/**
 * Mailbox rules only where the provider documents them: Gmail ignores dots and a `+tag` (googlemail.com is the same
 * mailbox); Microsoft consumer Outlook, Fastmail and Proton deliver `+tag` to the same mailbox. Every other domain
 * keeps its whole local part, because a custom domain's `a+b@` may be a different person's mailbox.
 */
const MAILBOX_RULES: Readonly<Record<string, { domain: string; dots: boolean; plus: boolean }>> = Object.freeze({
    'gmail.com': { domain: 'gmail.com', dots: true, plus: true },
    'googlemail.com': { domain: 'gmail.com', dots: true, plus: true },
    'outlook.com': { domain: 'outlook.com', dots: false, plus: true },
    'hotmail.com': { domain: 'hotmail.com', dots: false, plus: true },
    'live.com': { domain: 'live.com', dots: false, plus: true },
    'msn.com': { domain: 'msn.com', dots: false, plus: true },
    'fastmail.com': { domain: 'fastmail.com', dots: false, plus: true },
    'proton.me': { domain: 'proton.me', dots: false, plus: true },
    'protonmail.com': { domain: 'protonmail.com', dots: false, plus: true },
    'pm.me': { domain: 'pm.me', dots: false, plus: true },
});

/** The domains whose mailbox rule can map another spelling onto `domain` (for the same-person account lookup). */
export function mailboxDomains(domain: string): string[] {
    const canonical = MAILBOX_RULES[domain]?.domain ?? domain;
    return [...new Set([canonical, ...Object.entries(MAILBOX_RULES).filter(([, rule]) => rule.domain === canonical).map(([name]) => name)])];
}

/**
 * The person key of a verified email: trimmed and lower-cased, plus the provider's documented mailbox rule above.
 * null for anything that is not one plain address.
 */
export function normalizeEmail(email: string | null | undefined): string | null {
    if (typeof email !== 'string') return null;
    const value = email.trim().toLowerCase();
    const match = /^([^\s@]+)@([^\s@]+\.[^\s@]+)$/.exec(value);
    if (!match) return null;
    let [, local, domain] = match as unknown as [string, string, string];
    const rule = MAILBOX_RULES[domain];
    if (rule) {
        if (rule.plus) local = local.split('+')[0]!;
        if (rule.dots) local = local.replace(/\./g, '');
        domain = rule.domain;
    }
    return local ? `${local}@${domain}` : null;
}

/** The sign-in subject: the linked Auth0 subject when present, else the Supabase account itself. */
export function authSubjectFor(userId: string, auth0Subject: string | null | undefined): string {
    return typeof auth0Subject === 'string' && auth0Subject.trim() ? `auth0:${auth0Subject.trim()}` : `supabase:${userId}`;
}

export const TRIAL_ENTITLEMENT_SUFFIX = 'trial' as const;
const TRIAL_ENTITLEMENT = /^ezil-os:v1:standard_monthly_v3:([A-Za-z0-9_]+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):trial$/;

/**
 * The trial's AI credits: the Standard plan's period amount, under its OWN entitlement root (distinct from every paid
 * period root `ezil-os:v1:standard_monthly_v3:<sub>:<start>`), expiring exactly at the trial end with no tail, so a
 * trial that ends unpaid keeps no trial-funded credits. One per subscription; the person index makes it one per person.
 */
export function trialEntitlement(input: { subscriptionId: string; trialStart: Date; trialEnd: Date }): AiCreditEntitlement {
    const start = input.trialStart.getTime(), end = input.trialEnd.getTime();
    if (!/^sub_[A-Za-z0-9_]+$/.test(input.subscriptionId) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
        throw new TypeError('Invalid trial entitlement');
    }
    const entitlementId = `ezil-os:v${AI_CREDIT_POLICY_VERSION}:${TRIAL_SKU}:${input.subscriptionId}:${input.trialStart.toISOString()}:${TRIAL_ENTITLEMENT_SUFFIX}`;
    if (entitlementId.length > 193 || !TRIAL_ENTITLEMENT.test(entitlementId)) throw new TypeError('Invalid trial entitlement');
    return { entitlementId, credits: CATALOG_V3[TRIAL_SKU].aiCredits.amount, expiresAt: input.trialEnd.toISOString() };
}

export function parseTrialEntitlement(entitlementId: string): { subscriptionId: string; trialStart: Date } | null {
    const match = entitlementId.length <= 193 ? TRIAL_ENTITLEMENT.exec(entitlementId) : null;
    const trialStart = match ? new Date(match[2]!) : null;
    return match && trialStart && trialStart.toISOString() === match[2] ? { subscriptionId: match[1]!, trialStart } : null;
}

export type TrialRefusal = 'not_free' | 'operator_plan' | 'no_email' | 'email_unverified' | 'trial_used' | 'paid_before';

/** Server facts about the caller, read from auth.users and the billing tables (never from the client). */
export interface TrialFacts {
    emailNormalized: string | null;
    emailVerified: boolean;
    authSubject: string;
    /** The caller's own trial row, if any. */
    own: TrialRow | null;
    /**
     * Another claim on this person: a trial row of another account (or a started trial's tombstone) with the same
     * normalized email or sign-in subject, or any trial row of another account whose CURRENT email is this person.
     */
    claimedElsewhere: boolean;
    /** A positive paid Standard/Premium/Pro period (or a live legacy paid subscription) for this account or this email. */
    paidBefore: boolean;
}

/**
 * Eligibility in refusal order. An own unbound row (quoted / checkout) stays eligible: that is a retry of the same
 * person's abandoned checkout, never a second trial.
 */
export function trialEligibility(input: { facts: TrialFacts; planFamily: string; operatorPlan: boolean }):
    { eligible: true } | { eligible: false; reason: TrialRefusal } {
    const { facts } = input;
    if (input.operatorPlan) return { eligible: false, reason: 'operator_plan' };
    if (input.planFamily !== 'free') return { eligible: false, reason: 'not_free' };
    if (facts.emailNormalized === null) return { eligible: false, reason: 'no_email' };
    if (!facts.emailVerified) return { eligible: false, reason: 'email_unverified' };
    if (facts.own && !UNBOUND_TRIAL_STATUSES.includes(facts.own.status)) return { eligible: false, reason: 'trial_used' };
    if (facts.claimedElsewhere) return { eligible: false, reason: 'trial_used' };
    if (facts.paidBefore) return { eligible: false, reason: 'paid_before' };
    return { eligible: true };
}

/** Local extension: the frozen shared BillingStore port is unchanged (as ai-credits.ts does for top-ups). */
export interface TrialStore {
    trialFacts(userId: string): Promise<TrialFacts>;
    trialById(trialId: string): Promise<TrialRow | null>;
    /**
     * Claim or refresh the caller's quote under a per-person lock. A bound row, or another account holding the same
     * email or subject, refuses `trial_used` (the unique constraints decide a race). Returns the superseded open
     * checkout session, if any, so the caller can expire it.
     */
    claimTrialQuote(input: { userId: string; authSubject: string; emailNormalized: string; quotedAt: Date; trialEnd: Date; returnOrigin: string }):
        Promise<{ status: 'quoted'; trial: TrialRow; supersededCheckoutSessionId: string | null } | { status: 'refused'; reason: 'trial_used' }>;
    /** Record the checkout opened for exactly this quote (CAS on quoted_at); 'stale' when the quote changed or bound. */
    attachTrialCheckout(input: { trialId: string; userId: string; quotedAt: Date; checkoutSessionId: string; customerId: string }):
        Promise<'attached' | 'stale'>;
    /** Bind the trial to the one subscription that started it. 'conflict' when it is already bound elsewhere. */
    bindTrialSubscription(input: { trialId: string; userId: string; customerId: string; subscriptionId: string; trialStart: Date }):
        Promise<'bound' | 'conflict' | 'missing'>;
    setTrialStatus(input: { trialId: string; subscriptionId: string; status: TrialStatus; from: readonly TrialStatus[] }): Promise<void>;
    /** first_paid_at = coalesce(first_paid_at, at): set once, by the first positive paid period grant. */
    markSubscriptionPaid(subscriptionId: string, at: Date): Promise<void>;
    /** The stored AI receipt with this event key, if any. */
    outboxByEventKey(eventKey: string): Promise<{ eventKey: string; userId: string; kind: string; payload: Record<string, unknown> } | null>;
}

export function hasTrials<T extends object>(store: T): store is T & TrialStore {
    return ['trialFacts', 'trialById', 'claimTrialQuote', 'attachTrialCheckout', 'bindTrialSubscription', 'setTrialStatus',
        'markSubscriptionPaid', 'outboxByEventKey'].every(name => typeof (store as Record<string, unknown>)[name] === 'function');
}
