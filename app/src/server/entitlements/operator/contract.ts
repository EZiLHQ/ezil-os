/**
 * Product entitlements v1, producer `ezil-os` (Gateway contract 58d78935: docs/PRODUCT-ENTITLEMENTS-CONTRACT.md and
 * src/product-entitlements/contract.ts in the EZiL AI Gateway, fixtures at 93ed03f2). EZiL OS's side of the wire:
 * the strict command parser, canonical JSON and payload hash, and the answer shapes. The OS amendments (Plans brief,
 * ACK 2026-11-04) are applied here: no AI credits in the catalog, one live assignment per account, no scheduled or
 * back-dated starts, provisioning always not_applicable.
 */
import { createHash } from 'node:crypto';
import { CATALOG_V3 } from '@/server/billing/v3/contract';
import { OPERATOR_SKUS, type OperatorEntitlementRow, type OperatorSku } from '@/server/billing/v3/operator-access';

export const PRODUCER = 'ezil-os';
export const SCOPE = 'individual';
export const FORMATS = {
    sourceCatalog: 'ezil.product-source-catalog.v1',
    sourceAssignments: 'ezil.product-source-assignments.v1',
    command: 'ezil.admin-entitlement-command.v1',
    result: 'ezil.admin-entitlement-result.v1',
} as const;

export const REFUSAL_CODES = ['paid_subscription_conflict', 'identity_not_found', 'ambiguous_identity', 'foreign_target', 'not_member',
    'catalog_revision_mismatch', 'product_not_assignable', 'stale_revision', 'payload_mismatch', 'assignment_not_found', 'invalid_command',
    'unauthorized_sender'] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF = /^[a-z0-9][a-z0-9_.:-]{0,79}$/;
const REVISION = /^[A-Za-z0-9._:-]{1,80}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
/** Starts are never scheduled or back-dated: null, or this close to now (OS amendment, as Universe's C4). */
export const START_TOLERANCE_MS = 300_000;

export interface IndividualTarget { readonly kind: 'individual'; readonly os_user_id: string; readonly account_public_id: string }
export interface Command {
    readonly format: typeof FORMATS.command; readonly command_id: string; readonly action: 'assign' | 'change' | 'end';
    readonly producer: typeof PRODUCER; readonly scope: typeof SCOPE;
    readonly operator: { readonly via: string; readonly actor: string; readonly email: string | null };
    readonly product: { readonly ref: string; readonly catalog_revision: string } | null;
    readonly target: IndividualTarget; readonly quantity: null; readonly starts_at: string | null;
    readonly validity: { readonly ends_at: string } | { readonly until_revoked: true } | null;
    readonly reason: string; readonly assignment: { readonly ref: string; readonly expected_revision: number } | null;
    readonly billing_effect: 'none'; readonly credit_option: 'none';
}
export interface Assignment {
    readonly ref: string; readonly revision: number; readonly producer: typeof PRODUCER; readonly scope: typeof SCOPE;
    readonly product_ref: OperatorSku; readonly target: IndividualTarget; readonly quantity: null; readonly starts_at: string;
    readonly ends_at: string | null; readonly until_revoked: boolean; readonly state: 'active' | 'ended';
}
export interface EffectiveAccess { readonly state: 'active' | 'none'; readonly product_ref: string | null; readonly via: 'operator' | 'stripe' | null }
export interface Result {
    readonly format: typeof FORMATS.result; readonly command_id: string; readonly outcome: 'applied' | 'replayed' | 'refused';
    readonly refusal: { readonly code: RefusalCode; readonly message: string } | null; readonly assignment: Assignment | null;
    readonly effective_access: EffectiveAccess; readonly provisioning: { readonly state: 'not_applicable' };
    readonly credit_status: { readonly state: 'not_requested' }; readonly audit_receipt: { readonly ref: string; readonly at: string } | null;
}

export class InvalidCommand extends Error { constructor(what: string) { super(what); this.name = 'InvalidCommand'; } }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const rec = (v: unknown, what: string) => { if (!isRecord(v)) throw new InvalidCommand(what); return v; };
const only = (o: Record<string, unknown>, keys: readonly string[], what: string) => {
    for (const k of Object.keys(o)) if (!keys.includes(k)) throw new InvalidCommand(what);
    for (const k of keys) if (!Object.hasOwn(o, k)) throw new InvalidCommand(what);
};
const str = (v: unknown, re: RegExp, what: string): string => { if (typeof v !== 'string' || !re.test(v)) throw new InvalidCommand(what); return v; };
const text = (v: unknown, max: number, what: string): string => {
    if (typeof v !== 'string' || v.trim().length === 0 || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new InvalidCommand(what);
    return v;
};
const iso = (v: unknown, what: string): string => {
    const value = str(v, ISO, what);
    if (!Number.isFinite(Date.parse(value))) throw new InvalidCommand(what);
    return value;
};

/** The command_id alone, for answering a body that is not a valid command (400 when even this is missing). */
export function commandIdOf(body: unknown): string | null {
    return isRecord(body) && typeof body.command_id === 'string' && UUID.test(body.command_id) ? body.command_id : null;
}

/** Strict: every field, no extras, the ezil-os producer and individual scope only. Throws InvalidCommand. */
export function parseCommand(v: unknown): Command {
    const c = rec(v, 'command');
    only(c, ['format', 'command_id', 'action', 'producer', 'scope', 'operator', 'product', 'target', 'quantity', 'starts_at', 'validity',
        'reason', 'assignment', 'billing_effect', 'credit_option'], 'command fields');
    if (c.format !== FORMATS.command) throw new InvalidCommand('format');
    if (c.producer !== PRODUCER || c.scope !== SCOPE) throw new InvalidCommand('producer');
    if (c.billing_effect !== 'none' || c.credit_option !== 'none') throw new InvalidCommand('billing_effect');
    if (c.action !== 'assign' && c.action !== 'change' && c.action !== 'end') throw new InvalidCommand('action');
    const op = rec(c.operator, 'operator'); only(op, ['via', 'actor', 'email'], 'operator');
    const operator = { via: str(op.via, /^[a-z0-9_.:-]{1,80}$/, 'operator.via'), actor: text(op.actor, 200, 'operator.actor'),
        email: op.email === null ? null : text(op.email, 320, 'operator.email') };
    const t = rec(c.target, 'target'); only(t, ['kind', 'os_user_id', 'account_public_id'], 'target');
    if (t.kind !== 'individual') throw new InvalidCommand('target');
    const target: IndividualTarget = { kind: 'individual', os_user_id: str(t.os_user_id, UUID, 'target'), account_public_id: str(t.account_public_id, UUID, 'target') };
    if (c.quantity !== null) throw new InvalidCommand('quantity');
    const product = c.product === null ? null : (() => {
        const p = rec(c.product, 'product'); only(p, ['ref', 'catalog_revision'], 'product');
        return { ref: str(p.ref, REF, 'product.ref'), catalog_revision: str(p.catalog_revision, REVISION, 'product.catalog_revision') };
    })();
    const validity = c.validity === null ? null : (() => {
        const w = rec(c.validity, 'validity');
        if (Object.hasOwn(w, 'ends_at')) { only(w, ['ends_at'], 'validity'); return { ends_at: iso(w.ends_at, 'validity.ends_at') }; }
        only(w, ['until_revoked'], 'validity');
        if (w.until_revoked !== true) throw new InvalidCommand('validity');
        return { until_revoked: true as const };
    })();
    const assignment = c.assignment === null ? null : (() => {
        const a = rec(c.assignment, 'assignment'); only(a, ['ref', 'expected_revision'], 'assignment');
        const revision = a.expected_revision;
        if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new InvalidCommand('assignment.expected_revision');
        return { ref: str(a.ref, REF, 'assignment.ref'), expected_revision: revision as number };
    })();
    const startsAt = c.starts_at === null ? null : iso(c.starts_at, 'starts_at');
    // Per action: assign names a product and a validity, with no assignment; change and end name the assignment.
    if (c.action === 'assign' && (product === null || validity === null || assignment !== null)) throw new InvalidCommand('assign');
    if (c.action === 'change' && (assignment === null || (product === null && validity === null))) throw new InvalidCommand('change');
    if (c.action === 'end' && (assignment === null || product !== null || validity !== null || startsAt !== null)) throw new InvalidCommand('end');
    return { format: FORMATS.command, command_id: str(c.command_id, UUID, 'command_id'), action: c.action, producer: PRODUCER, scope: SCOPE,
        operator, product, target, quantity: null, starts_at: startsAt, validity, reason: text(c.reason, 500, 'reason'), assignment,
        billing_effect: 'none', credit_option: 'none' };
}

/** Canonical JSON: sorted keys, no whitespace; numbers are safe integers (the contract has no fractions). */
export function canonicalJson(v: unknown): string {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new TypeError('non-integer number'); return String(v); }
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    if (isRecord(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
    throw new TypeError('unsupported value');
}

/** sha256 of the canonical JSON of the command as sent, without `command_id` (the Gateway's payloadSha256). */
export function payloadSha256(body: Record<string, unknown>): string {
    const rest = Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'command_id'));
    return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/** The OS catalog: Free (never assignable), Standard and Premium. No included AI credits: an assignment grants none. */
export function sourceCatalog() {
    const products = (['free_v3', ...OPERATOR_SKUS] as const).map(sku => {
        const offer = CATALOG_V3[sku];
        const assignable = sku !== 'free_v3';
        return { ref: sku, name: offer.name, price: { amount_minor: offer.priceCents, currency: offer.currency, interval: 'month' as const, per: 'account' as const },
            included_ai_credits: null, assignable, refusal: assignable ? null : "Free is every account's default plan." };
    });
    const revision = createHash('sha256').update(canonicalJson(products.filter(p => p.assignable).map(p => ({ ref: p.ref, price: p.price,
        session_max_seconds: CATALOG_V3[p.ref].sessionMaxSeconds })))).digest('hex').slice(0, 16);
    return { format: FORMATS.sourceCatalog, producer: PRODUCER, scope: SCOPE, catalog_revision: `os-v3.${revision}`, products };
}

const isoMs = (d: Date) => d.toISOString();

/** The contract view of a stored assignment at `now` (individual: never scheduled, never pending). */
export function assignmentView(row: OperatorEntitlementRow, now: Date): Assignment {
    const ended = row.endedAt !== null || (row.endsAt !== null && row.endsAt.getTime() <= now.getTime());
    // An operator `end` closes the validity at that moment, so the view's end is the earlier of the two.
    const end = row.endedAt !== null && (row.endsAt === null || row.endedAt < row.endsAt) ? row.endedAt : row.endsAt;
    return { ref: row.ref, revision: row.revision, producer: PRODUCER, scope: SCOPE, product_ref: row.sku,
        target: { kind: 'individual', os_user_id: row.userId, account_public_id: row.accountPublicId }, quantity: null,
        starts_at: isoMs(row.startsAt), ends_at: end === null ? null : isoMs(end), until_revoked: end === null, state: ended ? 'ended' : 'active' };
}

export function refused(commandId: string, code: RefusalCode, message: string, effective: EffectiveAccess): Result {
    return { format: FORMATS.result, command_id: commandId, outcome: 'refused', refusal: { code, message }, assignment: null,
        effective_access: effective, provisioning: { state: 'not_applicable' }, credit_status: { state: 'not_requested' }, audit_receipt: null };
}

export const NO_ACCESS: EffectiveAccess = Object.freeze({ state: 'none', product_ref: null, via: null });
