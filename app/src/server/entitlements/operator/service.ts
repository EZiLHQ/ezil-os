/**
 * Product entitlements v1, producer `ezil-os`: the command, catalog and assignments behaviour behind the signed
 * Gateway routes (http.ts). Storage, identity and the Stripe view are injected (store.ts in production), so the same
 * rules run against PostgreSQL and in unit tests.
 *
 * Rules (contract 58d78935 with the OS amendments on the Plans brief):
 * - idempotency: applied commands replay as "replayed"; resolved-target business refusals replay their original
 *   refusal. The same id with another payload is payload_mismatch. Authentication, structure and unresolved identity
 *   failures are outside this durable boundary. Refusals write only an append-only receipt, never access.
 * - identity: the OS user must be live and linked to exactly this Gateway account (identity_not_found /
 *   ambiguous_identity), checked before anything about the account is read or written.
 * - Stripe: never replaced. Paid access (or a checkout still incomplete) refuses an assign, or a change that gives
 *   more, with paid_subscription_conflict before any write; ending or shortening always works.
 * - one live operator assignment per account; starts are never scheduled or back-dated; validity is explicit.
 */
import { operatorGrantInEffect, isOperatorSku, type OperatorEntitlementRow, type OperatorSku } from '@/server/billing/v3/operator-access';
import { addCalendarMonthUtc } from '@/server/billing/v3/trial';
import {
    assignmentView, FORMATS, InvalidCommand, NO_ACCESS, parseCommand, payloadSha256, PRODUCER, refused, SCOPE, sourceCatalog,
    START_TOLERANCE_MS, type Command, type EffectiveAccess, type IndividualTarget, type Result,
} from './contract';

export type IdentityCheck = 'ok' | 'identity_not_found' | 'ambiguous_identity';
/** What Stripe gives this account now (Stripe-only standing; never written by this source). */
export interface StripeView {
    paidAccess: boolean;
    /** Actual compute funding; standing alone still owns conflict/precedence when false. */
    computeActive: boolean;
    /** The paid plan's SKU while `paidAccess`, else null. */
    productRef: string | null;
    /** The newest subscription's Stripe status verbatim; null = the account never had a Stripe subscription. */
    state: string | null;
    /** A Stripe checkout still incomplete (a subscription created, its first payment not done). */
    checkoutOpen: boolean;
}
export interface StoredEvent { payloadSha256: string; result: Result }
/** One transaction, with the command and the account serialized (store.ts takes both advisory locks first). */
export interface CommandStore {
    findEvent(commandId: string): Promise<StoredEvent | null>;
    /** Roll back grant/expiry/event changes on a refusal, retaining the command/account locks. */
    withAccessTransaction(run: () => Promise<Result>): Promise<Result>;
    assignments(userId: string): Promise<OperatorEntitlementRow[]>;
    insertAssignment(row: OperatorEntitlementRow): Promise<void>;
    /** Compare-and-set on the revision; false when it moved (nothing written). */
    updateAssignment(ref: string, expectedRevision: number, next: Pick<OperatorEntitlementRow, 'revision' | 'sku' | 'endsAt' | 'endedAt'>): Promise<boolean>;
    /** Closes a live grant whose end already passed (ended_at = its end), so a new one can be assigned. */
    closeLapsed(ref: string, now: Date): Promise<void>;
    insertEvent(event: { id: string; commandId: string; payloadSha256: string; action: Command['action']; assignmentRef: string | null; revision: number | null;
        userId: string; operatorVia: string; operatorActor: string; senderKid: string; reason: string; result: Result }): Promise<void>;
}
export interface OperatorEntitlementDeps {
    now(): Date;
    newId(): string;
    identity(target: IndividualTarget): Promise<IdentityCheck>;
    stripe(userId: string): Promise<StripeView>;
    readAssignments(userId: string): Promise<OperatorEntitlementRow[]>;
    withCommand<T>(commandId: string, userId: string, run: (store: CommandStore) => Promise<T>): Promise<T>;
}

/** The access OS admission resolves: Stripe paid access wins, else the operator grant in effect, else none. */
export function effectiveAccess(stripe: StripeView, rows: readonly OperatorEntitlementRow[], now: Date): EffectiveAccess {
    if (stripe.paidAccess) return stripe.computeActive
        ? { state: 'active', product_ref: stripe.productRef, via: 'stripe' } : NO_ACCESS;
    const grant = operatorGrantInEffect(rows, now);
    return grant ? { state: 'active', product_ref: grant.sku, via: 'operator' } : NO_ACCESS;
}

export function catalog() {
    return sourceCatalog();
}

/** GET assignments: null when the pair is not one linked account (the route answers 404 and reveals nothing). */
export async function readAssignments(deps: OperatorEntitlementDeps, target: IndividualTarget) {
    if (await deps.identity(target) !== 'ok') return null;
    const [rows, stripe] = await Promise.all([deps.readAssignments(target.os_user_id), deps.stripe(target.os_user_id)]);
    const now = deps.now();
    return { format: FORMATS.sourceAssignments, target, effective_access: effectiveAccess(stripe, rows, now),
        assignments: rows.slice(0, 50).map(row => assignmentView(row, now)),
        stripe: stripe.state === null ? null : { state: stripe.state, product_ref: stripe.productRef } };
}

const live = (row: OperatorEntitlementRow) => row.endedAt === null;
const inEffect = (row: OperatorEntitlementRow, now: Date) => live(row) && row.startsAt.getTime() <= now.getTime()
    && (row.endsAt === null || row.endsAt.getTime() > now.getTime());
const RANK: Readonly<Record<OperatorSku, number>> = { standard_monthly_v3: 1, premium_monthly_v3: 2 };

/** POST commands, for a body whose command_id is valid (the route answers 400 otherwise). Never throws a refusal. */
export async function handleCommand(deps: OperatorEntitlementDeps, body: Record<string, unknown>, commandId: string, senderKid: string): Promise<Result> {
    let command: Command;
    try {
        command = parseCommand(body);
    } catch (error) {
        if (error instanceof InvalidCommand) return refused(commandId, 'invalid_command', `The command is not a valid ${PRODUCER} ${SCOPE} command (${error.message}).`, NO_ACCESS);
        throw error;
    }
    const payload = payloadSha256(body);
    const userId = command.target.os_user_id;
    return deps.withCommand(command.command_id, userId, async store => {
        const prior = await store.findEvent(command.command_id);
        if (prior) {
            if (prior.payloadSha256 === payload) return prior.result.outcome === 'applied' ? { ...prior.result, outcome: 'replayed' } : prior.result;
            return refused(command.command_id, 'payload_mismatch', 'This command_id was already used for a different command.', NO_ACCESS);
        }
        const identity = await deps.identity(command.target);
        if (identity !== 'ok') return refused(command.command_id, identity, identity === 'identity_not_found'
            ? 'No live EZiL OS account is linked to this Gateway account.' : 'This Gateway account and EZiL OS user are not one unambiguous link.', NO_ACCESS);
        const now = deps.now();
        const result = await store.withAccessTransaction(async () => {
            const [rows, stripe] = await Promise.all([store.assignments(userId), deps.stripe(userId)]);
            const access = () => effectiveAccess(stripe, rows, now);
            const refuse = (code: Parameters<typeof refused>[1], message: string) => refused(command.command_id, code, message, access());
            const paidConflict = () => refuse('paid_subscription_conflict', stripe.paidAccess
                ? 'This account has a paid plan in Stripe; it was not changed.' : 'This account has a Stripe checkout in progress; it was not changed.');
            const catalogRevision = sourceCatalog().catalog_revision;
            const product = (): OperatorSku | Result => {
                const ref = command.product!.ref;
                if (!isOperatorSku(ref)) return refuse('product_not_assignable', ref === 'free_v3' ? "Free is every account's default plan." : 'This product is not in the EZiL OS catalog.');
                if (command.product!.catalog_revision !== catalogRevision) return refuse('catalog_revision_mismatch', 'The EZiL OS catalog changed; reload it and try again.');
                return ref;
            };
            const write = async (row: OperatorEntitlementRow, apply: () => Promise<boolean>) => {
                if (!await apply()) return refuse('stale_revision', 'The assignment changed meanwhile; reload it and try again.');
                const next = rows.filter(other => other.ref !== row.ref).concat(row);
                const id = deps.newId();
                const result: Result = { format: FORMATS.result, command_id: command.command_id, outcome: 'applied', refusal: null,
                    assignment: assignmentView(row, now), effective_access: effectiveAccess(stripe, next, now), provisioning: { state: 'not_applicable' },
                    credit_status: { state: 'not_requested' }, audit_receipt: { ref: `os-audit-${id}`, at: now.toISOString() } };
                await store.insertEvent({ id, commandId: command.command_id, payloadSha256: payload, action: command.action, assignmentRef: row.ref,
                    revision: row.revision, userId, operatorVia: command.operator.via, operatorActor: command.operator.actor, senderKid,
                    reason: command.reason, result });
                return result;
            };

            if (command.action === 'assign') {
                const sku = product();
                if (typeof sku !== 'string') return sku;
                const requestedStart = command.starts_at === null ? now : new Date(command.starts_at);
                if (Math.abs(requestedStart.getTime() - now.getTime()) > START_TOLERANCE_MS) return refuse('invalid_command', 'starts_at must be now: scheduled and back-dated assignments are not supported.');
                // Tolerance accepts sender clock skew, never scheduling: the period begins at the server's now.
                const startsAt = now;
                // Server-authoritative period: an operator plan runs the plan's source-defined one calendar month
                // (billing/v3/trial.ts addCalendarMonthUtc), anchored at the server's start, and only that computed end is
                // stored. A well-formed ends_at on the frozen v1 wire is a non-authoritative hint: it is never compared
                // with this end (a sender start across midnight or a late retry of an unsaved command would differ) and it
                // can never extend access because it never determines the stored end. Until-revoked is not supported.
                const validity = command.validity!;
                if ('until_revoked' in validity) return refuse('invalid_command', 'An operator plan runs one calendar month; until-revoked is not supported.');
                const endsAt = addCalendarMonthUtc(startsAt);                if (stripe.paidAccess || stripe.checkoutOpen) return paidConflict();
                const current = rows.find(live);
                if (current && (current.endsAt === null || current.endsAt.getTime() > now.getTime())) return refuse('invalid_command', 'An operator assignment is already in effect for this account; change or end it.');
                // A live grant that lapsed by its own end date is closed at that date before the new one starts.
                if (current) await store.closeLapsed(current.ref, now);
                const row: OperatorEntitlementRow = { ref: `osg-${deps.newId()}`, revision: 1, userId, accountPublicId: command.target.account_public_id,
                    sku, startsAt, endsAt, endedAt: null, issuedBy: command.issued_by ?? null };
                return write(row, async () => { await store.insertAssignment(row); return true; });
            }

            const target = rows.find(row => row.ref === command.assignment!.ref);
            if (!target || target.accountPublicId !== command.target.account_public_id) return refuse('assignment_not_found', 'No such operator assignment for this account.');
            if (target.revision !== command.assignment!.expected_revision) return refuse('stale_revision', 'The assignment changed meanwhile; reload it and try again.');
            if (!inEffect(target, now)) return refuse('invalid_command', 'This assignment has already ended.');

            if (command.action === 'end') {
                const row = { ...target, revision: target.revision + 1, endedAt: now };
                return write(row, () => store.updateAssignment(target.ref, target.revision, row));
            }

            // change: product only (Standard <-> Premium). The one-calendar-month period is fixed at assign and is
            // preserved across a product change; validity is never restated or extended here (use end to stop early).
            // The start may only be restated.
            if (command.validity !== null) return refuse('invalid_command', 'An operator plan runs one calendar month; validity cannot be changed — use end to stop access.');
            if (command.starts_at !== null && new Date(command.starts_at).getTime() !== target.startsAt.getTime()) {
                return refuse('invalid_command', 'starts_at cannot move; restate the current start or send null.');
            }
            // The parser requires a product or a validity on change; with validity refused above, the product is present.
            const sku = product();
            if (typeof sku !== 'string') return sku;
            if (sku === target.sku) return refuse('invalid_command', 'Nothing would change.');
            // Only an upgrade gives more; the preserved period end never does.
            const givesMore = RANK[sku] > RANK[target.sku];
            if (givesMore && (stripe.paidAccess || stripe.checkoutOpen)) return paidConflict();
            const row = { ...target, revision: target.revision + 1, sku, endsAt: target.endsAt };
            return write(row, () => store.updateAssignment(target.ref, target.revision, row));
        });
        if (result.outcome === 'refused') {
            // The access savepoint has rolled back before this immutable refusal receipt.
            await store.insertEvent({ id: deps.newId(), commandId: command.command_id, payloadSha256: payload, action: command.action,
                assignmentRef: null, revision: null, userId, operatorVia: command.operator.via, operatorActor: command.operator.actor,
                senderKid, reason: command.reason, result });
        }
        return result;
    });
}
