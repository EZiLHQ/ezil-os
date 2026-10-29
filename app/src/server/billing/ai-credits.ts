import { isDeepStrictEqual } from 'node:util';
import type { BillingStore, GrantInsert, GrantRow, OutboxInsert } from './ports';
import type { CatalogPack } from './types';
import { aiPackCheckoutEligible, CUSTOM_TOPUP_SKU } from './catalog';
import { AI_CREDIT_POLICY_VERSION, CATALOG_V3, UPGRADE_AI_ENTITLEMENT_SUFFIX, upgradeAiCredits, type PlanSkuV3 } from './v3/contract';

const DAY = 86_400_000;
export const AI_CREDIT_PROTOCOL = 'ezil-ai-credits-v1';
export interface AiCreditEntitlement {
    entitlementId: string;
    credits: number;
    expiresAt: string;
}

/** Free's periodStart is the grant instant, supplied by the caller, never a wall clock read. */
export function aiCreditEntitlement(input: {
    userId: string; sku: PlanSkuV3; subscriptionId: string | null;
    periodStart: Date; periodEnd: Date | null; invoiceId: string | null;
}): AiCreditEntitlement {
    const policy = CATALOG_V3[input.sku].aiCredits;
    const start = input.periodStart.getTime();
    if (!input.userId || !Number.isFinite(start)) throw new TypeError('Invalid AI grant');
    if (policy.per === 'period' && (!input.subscriptionId || !input.invoiceId || !input.periodEnd
        || !Number.isFinite(input.periodEnd.getTime()) || input.periodEnd.getTime() <= start)) {
        throw new TypeError('Invalid AI period');
    }
    return {
        entitlementId: policy.per === 'once' ? `ezil-os:v${AI_CREDIT_POLICY_VERSION}:free-once:${input.userId}`
            : `ezil-os:v${AI_CREDIT_POLICY_VERSION}:${input.sku}:${input.subscriptionId}:${input.periodStart.toISOString()}`,
        credits: policy.amount,
        expiresAt: new Date(policy.per === 'once' ? start + 365 * DAY : input.periodEnd!.getTime() + 3 * DAY).toISOString(),
    };
}

const UPGRADE_ENTITLEMENT = /^ezil-os:v1:premium_monthly_v3:([A-Za-z0-9_]+):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z):upgrade$/;

/**
 * Round 3 D1: the prorated Standard → Premium credits of one paid upgrade invoice.
 * `credits` may be 0 (the caller then enqueues nothing); the id never exceeds 193 chars.
 */
export function aiUpgradeEntitlement(input: {
    userId: string; subscriptionId: string; periodStart: Date; periodEnd: Date; effectiveAt: Date;
}): AiCreditEntitlement {
    const [start, end, at] = [input.periodStart, input.periodEnd, input.effectiveAt].map(date => date.getTime());
    if (!input.userId || ![start, end, at].every(Number.isFinite) || end! <= start! || at! < start! || at! >= end!) {
        throw new TypeError('Invalid AI upgrade period');
    }
    const entitlementId = `ezil-os:v${AI_CREDIT_POLICY_VERSION}:premium_monthly_v3:${input.subscriptionId}:`
        + `${input.effectiveAt.toISOString()}:${UPGRADE_AI_ENTITLEMENT_SUFFIX}`;
    if (entitlementId.length > 193 || !UPGRADE_ENTITLEMENT.test(entitlementId)) throw new TypeError('Invalid AI upgrade entitlement');
    return {
        entitlementId,
        credits: upgradeAiCredits({ fromSku: 'standard_monthly_v3', toSku: 'premium_monthly_v3',
            periodStart: input.periodStart.toISOString(), periodEnd: input.periodEnd.toISOString(), effectiveAt: input.effectiveAt.toISOString() }),
        expiresAt: new Date(end! + 3 * DAY).toISOString(),
    };
}

export function parseAiUpgradeEntitlement(entitlementId: string): { subscriptionId: string; effectiveAt: Date } | null {
    const match = entitlementId.length <= 193 ? UPGRADE_ENTITLEMENT.exec(entitlementId) : null;
    const effectiveAt = match ? new Date(match[2]!) : null;
    return match && effectiveAt && effectiveAt.toISOString() === match[2] ? { subscriptionId: match[1]!, effectiveAt } : null;
}

export function aiCreditOutboxItem(userId: string, entitlement: AiCreditEntitlement, action: 'grant' | 'revoke', invoiceId: string | null): OutboxInsert {
    const eventId = `${entitlement.entitlementId}:${action}`;
    return { eventKey: eventId, userId, kind: action === 'grant' ? 'ai_grant' : 'ai_revoke', payload: {
        protocol: AI_CREDIT_PROTOCOL, policyVersion: AI_CREDIT_POLICY_VERSION, invoiceId,
        ...entitlement, eventId, action,
    } };
}

/** Only explicit whole-credit pack policy can create a deliverable top-up receipt. */
export function aiTopupOutboxItem(userId: string, pack: CatalogPack, paymentIntentId: string, expiresAt: Date): OutboxInsert | null {
    if (!aiPackCheckoutEligible(pack)) return null;
    const entitlementId = `ezil-os:v1:topup:${pack.sku}:${paymentIntentId}`;
    if (!userId || (pack.sku !== CUSTOM_TOPUP_SKU && !/^ai_pack_[A-Za-z0-9_]+$/.test(pack.sku)) || !/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)
        || entitlementId.length > 193 || !Number.isFinite(expiresAt.getTime())
        || !Number.isSafeInteger(pack.creditCents) || pack.creditCents < 1) throw new TypeError('Invalid AI topup');
    const item = aiCreditOutboxItem(userId, { entitlementId, credits: pack.aiCredits, expiresAt: expiresAt.toISOString() }, 'grant', null);
    return { ...item, payload: { ...item.payload, packSku: pack.sku, paymentIntentId,
        amountUsdMicro: (BigInt(pack.creditCents) * BigInt(10_000)).toString(),
        bucket: 'purchased', provider: 'stripe', providerObjectId: paymentIntentId } };
}

/** Local extension keeps the frozen shared billing ports unchanged. */
export interface AiTopupReceiptStore {
    aiTopupReceipt(userId: string, paymentIntentId: string): Promise<OutboxInsert | null>;
    /** Commit the first receipt and monetary ledger entry together; replays retain both. */
    recordAiTopup(grant: GrantInsert, receipt: OutboxInsert): Promise<'applied' | 'review:customer_mismatch' | 'review:legacy_topup_unfunded'>;
}

export function hasAiTopupReceipts(store: BillingStore): store is BillingStore & AiTopupReceiptStore {
    return 'aiTopupReceipt' in store && typeof store.aiTopupReceipt === 'function'
        && 'recordAiTopup' in store && typeof store.recordAiTopup === 'function';
}

/** Reverse the stored receipt, retaining its policy/amount if the catalog changes later. */
export function aiCreditRevokeItem(grant: OutboxInsert, cause?: { type: 'dispute' | 'refund'; id: string }): OutboxInsert {
    const p = grant.payload;
    if (p.protocol !== AI_CREDIT_PROTOCOL || typeof p.entitlementId !== 'string' || typeof p.credits !== 'number'
        || typeof p.expiresAt !== 'string' || p.action !== 'grant') throw new TypeError('Invalid AI credit receipt');
    const eventId = `${p.entitlementId}:revoke${cause ? `:${cause.type}:${cause.id}` : ''}`;
    if (!parseAiCreditEventId(p.entitlementId, eventId, 'revoke')) throw new TypeError('invalid_ai_event_id');
    return { userId: grant.userId, eventKey: eventId, kind: 'ai_revoke', payload: {
        protocol: p.protocol, policyVersion: p.policyVersion, invoiceId: p.invoiceId,
        entitlementId: p.entitlementId, credits: p.credits, expiresAt: p.expiresAt, eventId, action: 'revoke',
        ...(typeof p.paymentIntentId === 'string' ? { paymentIntentId: p.paymentIntentId, packSku: p.packSku } : {}),
        ...(typeof p.accountPublicId === 'string' ? { accountPublicId: p.accountPublicId } : {}),
    } };
}


/** W0.3: parse only the suffix of the exact canonical root; never truncate IDs. */
export function parseAiCreditEventId(root: string, eventId: string, action: string):
    { action: 'grant' | 'revoke' | 'restore'; cause?: 'dispute' | 'refund'; causeId?: string } | null {
    if (!/^ezil-os:v1:[A-Za-z0-9._:-]+$/.test(root) || root.length > 193
        || eventId.length > 200 || !eventId.startsWith(root + ':')) return null;
    const suffix = eventId.slice(root.length);
    if (action === 'grant' && suffix === ':grant') return { action };
    if (action === 'revoke' && suffix === ':revoke') return { action };
    const revoke = /^:revoke:(dispute|refund):([A-Za-z0-9_-]+)$/.exec(suffix);
    if (action === 'revoke' && revoke) return { action, cause: revoke[1] as 'dispute' | 'refund', causeId: revoke[2] };
    const restore = /^:restore:([A-Za-z0-9_-]+)$/.exec(suffix);
    return action === 'restore' && restore ? { action, cause: 'dispute', causeId: restore[1] } : null;
}

export function aiCreditRestoreItem(grant: OutboxInsert, disputeId: string): OutboxInsert {
    const revoke = aiCreditRevokeItem(grant, { type: 'dispute', id: disputeId });
    const eventId = `${grant.payload.entitlementId}:restore:${disputeId}`;
    if (!parseAiCreditEventId(String(grant.payload.entitlementId), eventId, 'restore')) throw new TypeError('invalid_ai_event_id');
    return { ...revoke, eventKey: eventId, kind: 'ai_restore', payload: { ...revoke.payload, eventId, action: 'restore' } };
}

export interface AiReversalInput {
    action: 'suspend' | 'revoke' | 'restore'; causeId: string; chargeId: string; customerId: string; userId: string;
    originals: GrantRow[]; receipts: OutboxInsert[];
}
export interface AiReversalStore {
    /** Locks cause/root, rechecks receipts, then atomically inserts the local and AI effects. */
    recordAiReversal(input: AiReversalInput): Promise<string>;
}
export function hasAiReversals(store: BillingStore): store is BillingStore & AiReversalStore {
    return 'recordAiReversal' in store && typeof store.recordAiReversal === 'function';
}
export type AiReversalReceipt = OutboxInsert & { deliveredAt?: Date | null };

function originalFacts(rows: GrantRow[]) {
    return [...rows].sort((a, b) => a.id.localeCompare(b.id)).map(g => ({ id: g.id, userId: g.userId,
        meter: g.meter, kind: g.kind, amount: g.amount.toString(), subscriptionId: g.subscriptionId,
        sourceType: g.sourceType, sourceId: g.sourceId,
        periodStart: g.periodStart?.toISOString() ?? null, periodEnd: g.periodEnd?.toISOString() ?? null }));
}
function sameLocalGrant(a: GrantInsert, b: GrantInsert) {
    return a.userId === b.userId && a.meter === b.meter && a.kind === b.kind && a.amount === b.amount
        && (a.subscriptionId ?? null) === (b.subscriptionId ?? null) && a.sourceType === b.sourceType && a.sourceId === b.sourceId
        && a.periodStart?.getTime() === b.periodStart?.getTime() && a.periodEnd?.getTime() === b.periodEnd?.getTime();
}
const localKey = (g: GrantInsert) => `${g.sourceType}:${g.sourceId}:${g.meter}:${g.kind}`;
const receiptTermsMatch = (a: OutboxInsert, b: OutboxInsert) => a.userId === b.userId
    && a.payload.protocol === b.payload.protocol && a.payload.entitlementId === b.payload.entitlementId
    && a.payload.credits === b.payload.credits && a.payload.expiresAt === b.payload.expiresAt
    && a.payload.invoiceId === b.payload.invoiceId && a.payload.paymentIntentId === b.payload.paymentIntentId;
/** Operator repair rows (round 4): a cause-less root revoke and a same-invoice `:correction-YYYYMMDD` child grant. */
const CORRECTION_ENTITLEMENT = /^(.+):correction-\d{8}$/;
const bareRevoke = (root: OutboxInsert, r: OutboxInsert) => r.eventKey === `${root.payload.entitlementId}:revoke`
    && r.kind === 'ai_revoke' && r.payload.action === 'revoke' && r.payload.eventId === r.eventKey
    && receiptTermsMatch(root, { ...r, payload: { ...r.payload,
        invoiceId: r.payload.invoiceId === null ? root.payload.invoiceId : r.payload.invoiceId } });
const deliveredRestore = (r: AiReversalReceipt) => r.deliveredAt != null
    && ['restored', 'already_restored'].includes(String((r.payload.delivery as { outcome?: string } | undefined)?.outcome));

/** Count each local ledger row once, even when several root receipts refer to it.
 * Only exact original-grant evidence can affect this purchase's remaining amount.
 */
function localReversalDeltas(input: AiReversalInput, corrections: GrantRow[], receipts: AiReversalReceipt[], grants: GrantInsert[],
    unbound = false): boolean {
    const facts = originalFacts(input.originals);
    const linked = new Map<string, { originalId: string; row: GrantRow }>();
    for (const receipt of receipts) {
        const root = String(receipt.payload.entitlementId);
        if (!input.receipts.some(r => r.payload.entitlementId === root)) continue;
        const event = parseAiCreditEventId(root, receipt.eventKey, String(receipt.payload.action));
        // Legacy terminal receipts carry no local cause binding. They never authorize a restore.
        if (!event || receipt.kind !== `ai_${event.action}`) return false;
        if (event.action === 'grant' || !event.causeId) continue;
        const proof = receipt.payload.reversal as { causeType?: unknown; causeId?: unknown; chargeId?: unknown;
            customerId?: unknown; originals?: unknown } | undefined;
        if (!proof || proof.causeType !== event.cause || proof.causeId !== event.causeId
            || proof.chargeId !== input.chargeId || proof.customerId !== input.customerId
            || !isDeepStrictEqual(proof.originals, facts) || receipt.userId !== input.userId) return false;
        const kind = event.action === 'restore' ? 'restore' : event.cause === 'refund' ? 'revoke' : 'suspend';
        const rows = corrections.filter(g => g.sourceType === event.cause && g.sourceId === event.causeId && g.kind === kind);
        if (rows.length !== input.originals.length) return false;
        for (const original of input.originals) {
            const row = rows.find(g => g.meter === original.meter);
            if (!row || !sameLocalGrant(row, { ...original, kind, sourceType: event.cause!, sourceId: event.causeId, amount: row.amount })
                || (kind === 'restore' ? row.amount < BigInt(0) || row.amount > original.amount
                    : row.amount > BigInt(0) || row.amount < -original.amount)) return false;
            const key = localKey(row);
            if (linked.has(key) && linked.get(key)!.originalId !== original.id) return false;
            linked.set(key, { originalId: original.id, row });
        }
        // New receipts also freeze the exact local delta, including zero-value audit rows.
        if (receipt.payload.localDeltas !== undefined && !isDeepStrictEqual(receipt.payload.localDeltas,
            input.originals.map(original => ({ originalGrantId: original.id, meter: original.meter,
                amount: rows.find(g => g.meter === original.meter)!.amount.toString() }))
                .sort((a, b) => a.originalGrantId.localeCompare(b.originalGrantId)))) return false;
    }
    for (let i = 0; i < input.originals.length; i++) {
        const original = input.originals[i]!;
        const grant = grants[i]!;
        const remaining = original.amount + [...linked.values()].filter(entry => entry.originalId === original.id)
            .reduce((total, entry) => total + entry.row.amount, BigInt(0));
        // Never repair unexplained historical debt by minting a compensating restore.
        if (remaining < BigInt(0) || remaining > original.amount) return false;
        const existing = corrections.find(g => localKey(g) === localKey(grant));
        if (existing) {
            // With every root operator-revoked no receipt binds this cause: only its own exact delta replays.
            if (!linked.has(localKey(existing)) && !(unbound && sameLocalGrant(existing, { ...grant, amount: -remaining }))) return false;
            grant.amount = existing.amount; // A replay retains its committed delta, regardless of later events.
        } else if (input.action === 'restore') {
            const suspend = linked.get(localKey({ ...grant, kind: 'suspend' }))?.row;
            if (!suspend || -suspend.amount > original.amount - remaining) return false;
            grant.amount = -suspend.amount;
        } else {
            grant.amount = -remaining;
        }
    }
    return true;
}

/** The upgrade grant row keeps the subscription period; the root carries the effective instant inside it. */
function upgradeRootMatches(entitlementId: string, expiresAt: string, g: GrantRow): boolean {
    const root = parseAiUpgradeEntitlement(entitlementId);
    return root !== null && g.subscriptionId === root.subscriptionId && g.periodStart !== null && g.periodEnd !== null
        && root.effectiveAt >= g.periodStart && root.effectiveAt < g.periodEnd
        && expiresAt === new Date(g.periodEnd.getTime() + 3 * DAY).toISOString();
}

/** Pure financial guard, run against a fresh snapshot under the store's cause/root locks. */
export function planAiReversal(input: AiReversalInput, snapshot: {
    originals: GrantRow[]; corrections: GrantRow[]; receipts: AiReversalReceipt[];
}): { outcome: string; grants: GrantInsert[]; outbox: OutboxInsert[] } {
    const refuse = (outcome: string) => ({ outcome, grants: [], outbox: [] });
    if (!input.receipts.length) return refuse('review:restore_receipt_missing');
    if (!input.originals.length || input.originals.some(g => g.userId !== input.userId || g.amount <= BigInt(0)
        || !['invoice', 'payment_intent'].includes(g.sourceType))
        || !isDeepStrictEqual(originalFacts(input.originals), originalFacts(snapshot.originals))) return refuse('review:restore_mismatch');
    const causeType = input.action === 'revoke' ? 'refund' : 'dispute';
    const proof = { causeType, causeId: input.causeId, chargeId: input.chargeId, customerId: input.customerId,
        originals: originalFacts(snapshot.originals) };
    const grants: GrantInsert[] = input.originals.map(g => ({ userId: input.userId, meter: g.meter,
        subscriptionId: g.subscriptionId, kind: input.action, amount: input.action === 'restore' ? g.amount : -g.amount,
        periodStart: g.periodStart, periodEnd: g.periodEnd, sourceType: causeType, sourceId: input.causeId }));
    // The existing ledger key has one row per meter/cause. Never partially apply an ambiguous purchase.
    if (new Set(grants.map(localKey)).size !== grants.length) return refuse('review:restore_mismatch');
    const outbox: OutboxInsert[] = [];
    let unbound = input.action !== 'restore';
    const matchesSource = (p: Record<string, unknown>) => snapshot.originals.some(g => g.sourceType === 'payment_intent'
        ? p.paymentIntentId === g.sourceId && p.entitlementId === `ezil-os:v1:topup:${p.packSku}:${g.sourceId}`
            && p.expiresAt === g.periodEnd?.toISOString()
        : p.invoiceId === g.sourceId && g.kind === 'plan_period' && g.subscriptionId && g.periodStart
            && ['standard_monthly_v3', 'premium_monthly_v3'].some(sku => p.entitlementId
                === `ezil-os:v1:${sku}:${g.subscriptionId}:${g.periodStart!.toISOString()}`)
        || p.invoiceId === g.sourceId && g.kind === 'upgrade_prorated' && upgradeRootMatches(String(p.entitlementId), String(p.expiresAt), g));
    const accountsOf = (root: OutboxInsert) => [...new Set([root, ...snapshot.receipts.filter(r => r.payload.entitlementId
        === root.payload.entitlementId)].flatMap(r => typeof r.payload.accountPublicId === 'string'
        && r.payload.accountPublicId ? [r.payload.accountPublicId] : []))];
    for (const root of input.receipts) {
        const p = root.payload;
        if (root.userId !== input.userId || root.kind !== 'ai_grant' || p.protocol !== AI_CREDIT_PROTOCOL
            || typeof p.entitlementId !== 'string' || typeof p.eventId !== 'string' || root.eventKey !== p.eventId
            || !parseAiCreditEventId(p.entitlementId, p.eventId, 'grant') || p.action !== 'grant'
            || !Number.isSafeInteger(p.credits) || Number(p.credits) < 1 || Number(p.credits) > 1_000_000
            || typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt))) return refuse('review:restore_mismatch');
        // A correction child is reversible only under its own sourced parent on identical, no larger terms.
        const parentId = CORRECTION_ENTITLEMENT.exec(p.entitlementId)?.[1];
        const parent = parentId === undefined ? undefined : input.receipts.find(r => r.payload.entitlementId === parentId);
        if (!matchesSource(p) && !(parent && matchesSource(parent.payload) && parent.payload.invoiceId === p.invoiceId
            && parent.payload.expiresAt === p.expiresAt && parent.payload.paymentIntentId === p.paymentIntentId
            && Number(p.credits) <= Number(parent.payload.credits)
            && isDeepStrictEqual(accountsOf(parent), accountsOf(root)))) return refuse('review:restore_mismatch');
        const family = snapshot.receipts.filter(r => r.payload.entitlementId === p.entitlementId);
        if (family.some(r => !receiptTermsMatch(root, r) && !bareRevoke(root, r))) return refuse('review:restore_mismatch');
        // An operator's cause-less revoke already removed this root; a second revoke ID is not known safe downstream.
        const revoked = family.some(r => bareRevoke(root, r));
        unbound &&= revoked;
        const accounts = accountsOf(root);
        if (accounts.length > 1) return refuse('review:restore_mismatch');
        const account = accounts[0];
        let item: OutboxInsert;
        try {
            item = input.action === 'restore' ? aiCreditRestoreItem(root, input.causeId)
                : aiCreditRevokeItem(root, { type: causeType, id: input.causeId });
        } catch { return refuse('review:invalid_ai_event_id'); }
        item.payload.reversal = proof;
        if (account) item.payload.accountPublicId = account;
        const previous = snapshot.receipts.find(r => r.eventKey === item.eventKey);
        if (previous && (!receiptTermsMatch(item, previous) || previous.kind !== item.kind
            || !isDeepStrictEqual(previous.payload.reversal, proof)
            || previous.payload.accountPublicId !== item.payload.accountPublicId)) return refuse('review:restore_mismatch');
        // All rows from this same D must belong to this exact purchase/owner, even on other roots.
        if (snapshot.receipts.some(r => {
            const metadata = r.payload.reversal as typeof proof | undefined;
            return metadata?.causeType === causeType && metadata.causeId === input.causeId
                && (!isDeepStrictEqual(metadata, proof) || r.userId !== input.userId
                    || !input.receipts.some(x => x.payload.entitlementId === r.payload.entitlementId));
        })) return refuse('review:restore_mismatch');
        if (input.action === 'restore' && !previous) {
            if (revoked) return refuse('review:restore_refused_terminal');
            const suspend = family.find(r => r.eventKey === `${p.entitlementId}:revoke:dispute:${input.causeId}`);
            if (!suspend) return refuse('failed:restore_suspend_pending');
            if (suspend.kind !== 'ai_revoke' || suspend.payload.action !== 'revoke'
                || !isDeepStrictEqual(suspend.payload.reversal, proof)) return refuse('review:restore_mismatch');
            if (!account || suspend.payload.accountPublicId !== account) return refuse('failed:restore_account_pending');
            if (family.some(r => {
                const parsed = parseAiCreditEventId(p.entitlementId as string, r.eventKey, String(r.payload.action));
                return parsed?.action === 'revoke' && parsed.cause !== 'dispute';
            })) return refuse('review:restore_refused_terminal');
            if (family.some(r => r.payload.overlappingDisputes === true || (() => {
                const parsed = parseAiCreditEventId(p.entitlementId as string, r.eventKey, String(r.payload.action));
                return parsed?.cause === 'dispute' && parsed.action === 'revoke' && parsed.causeId !== input.causeId
                    && !family.some(done => done.eventKey === `${p.entitlementId}:restore:${parsed.causeId}` && deliveredRestore(done));
            })())) return refuse('review:restore_review_required');
            const suspended = snapshot.corrections.filter(g => g.sourceType === 'dispute' && g.sourceId === input.causeId && g.kind === 'suspend');
            if (suspended.length !== grants.length || grants.some(g => !suspended.some(s =>
                s.amount <= BigInt(0) && s.amount >= -g.amount && sameLocalGrant(s, { ...g, kind: 'suspend', amount: s.amount })))) {
                return refuse('review:restore_mismatch');
            }
        }
        if (input.action === 'suspend' && !previous) {
            item.payload.overlappingDisputes = family.some(r => {
                const parsed = parseAiCreditEventId(p.entitlementId as string, r.eventKey, String(r.payload.action));
                return parsed?.action === 'revoke' && parsed.cause === 'dispute' && parsed.causeId !== input.causeId
                    && !family.some(done => done.eventKey === `${p.entitlementId}:restore:${parsed.causeId}` && deliveredRestore(done));
            });
        }
        if (!previous && !revoked) outbox.push(item);
    }
    if (new Set(input.receipts.map(r => r.payload.entitlementId)).size !== input.receipts.length) return refuse('review:restore_mismatch');
    if (!localReversalDeltas(input, snapshot.corrections, snapshot.receipts, grants, unbound)) {
        return refuse(input.action === 'restore' ? 'review:restore_mismatch' : 'review:local_reversal_mismatch');
    }
    for (const item of outbox) item.payload.localDeltas = input.originals.map((original, i) => ({
        originalGrantId: original.id, meter: original.meter, amount: grants[i]!.amount.toString(),
    })).sort((a, b) => a.originalGrantId.localeCompare(b.originalGrantId));
    const missing = grants.filter(g => !snapshot.corrections.some(s => localKey(s) === localKey(g)));
    if (grants.some(g => snapshot.corrections.some(s => localKey(s) === localKey(g) && !sameLocalGrant(s, g)))) return refuse('review:restore_mismatch');
    // A legacy positive or partial write is not proof that a dispute was won safely.
    if (input.action === 'restore' && ((outbox.length === 0) !== (missing.length === 0)
        || (outbox.length > 0 && (outbox.length !== input.receipts.length || missing.length !== grants.length)))) return refuse('review:restore_mismatch');
    return { outcome: 'applied', grants: missing, outbox };
}
