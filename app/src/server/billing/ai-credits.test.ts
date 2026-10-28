import { describe, expect, it } from 'vitest';
import { aiCreditEntitlement, aiCreditOutboxItem, aiCreditRevokeItem, aiTopupOutboxItem, aiCreditRestoreItem, aiUpgradeEntitlement,
    parseAiCreditEventId, parseAiUpgradeEntitlement } from './ai-credits';
import { findPack, customTopupPack } from './catalog';

const input = { userId: 'user', sku: 'standard_monthly_v3' as const, subscriptionId: 'sub',
    periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: new Date('2026-11-01T00:00:00Z'), invoiceId: 'invoice' };

describe('AI credit planning', () => {
    it('requires explicit pack credits and preserves the v1 topup receipt when reversing', () => {
        const pack = { ...findPack('ai_pack_10_v1')!, aiCredits: 1234 };
        expect(aiTopupOutboxItem('user', findPack('ai_pack_10_v1')!, 'pi_fixture', input.periodEnd)).toBeNull();
        const grant = aiTopupOutboxItem('user', pack, 'pi_fixture', input.periodEnd)!;
        expect(grant).toMatchObject({ eventKey: 'ezil-os:v1:topup:ai_pack_10_v1:pi_fixture:grant',
            payload: { protocol: 'ezil-ai-credits-v1', credits: 1234, amountUsdMicro: '10000000',
                expiresAt: input.periodEnd.toISOString(), paymentIntentId: 'pi_fixture' } });
        grant.payload.accountPublicId = 'pinned-account';
        pack.aiCredits = 9999;
        expect(aiCreditRevokeItem(grant)).toMatchObject({ eventKey: 'ezil-os:v1:topup:ai_pack_10_v1:pi_fixture:revoke',
            payload: { credits: 1234, expiresAt: input.periodEnd.toISOString(), accountPublicId: 'pinned-account', paymentIntentId: 'pi_fixture' } });
    });
    it('uses the custom SKU in the immutable grant and reversal root', () => {
        const receipt = aiTopupOutboxItem('user', customTopupPack(2500)!, 'pi_custom', input.periodEnd)!;
        expect(receipt).toMatchObject({ eventKey: 'ezil-os:v1:topup:ai_custom_v2:pi_custom:grant',
            payload: { credits: 250, amountUsdMicro: '25000000', packSku: 'ai_custom_v2' } });
        expect(aiCreditRevokeItem(receipt)).toMatchObject({ eventKey: 'ezil-os:v1:topup:ai_custom_v2:pi_custom:revoke',
            payload: { credits: 250 } });
    });
    it('reverses the immutable receipt and strips grant delivery metadata', () => {
        const grant = aiCreditOutboxItem('user', aiCreditEntitlement(input), 'grant', 'invoice');
        Object.assign(grant.payload, { credits: 1234, accountPublicId: 'original-account', delivery: { status: 'done' } });
        const revoke = aiCreditRevokeItem(grant);
        expect(revoke).toMatchObject({ kind: 'ai_revoke', eventKey: `${grant.payload.entitlementId}:revoke`,
            payload: { credits: 1234, policyVersion: 1, action: 'revoke', accountPublicId: 'original-account' } });
        expect(revoke.payload).not.toHaveProperty('delivery');
        expect(grant.payload.action).toBe('grant');
    });
    it.each([['standard_monthly_v3', 200], ['premium_monthly_v3', 1000]] as const)('plans %s with deterministic period ids and grace', (sku, credits) => {
        const grant = aiCreditEntitlement({ ...input, sku });
        expect(grant).toEqual({ entitlementId: `ezil-os:v1:${sku}:sub:2026-10-01T00:00:00.000Z`, credits,
            expiresAt: '2026-11-04T00:00:00.000Z' });
        expect(aiCreditEntitlement({ ...input, sku, invoiceId: 'another-invoice' })).toEqual(grant);
        expect(aiCreditOutboxItem('user', grant, 'grant', 'invoice').eventKey).toBe(`${grant.entitlementId}:grant`);
        expect(aiCreditOutboxItem('user', grant, 'revoke', 'invoice').eventKey).toBe(`${grant.entitlementId}:revoke`);
    });
    it('gives Free 100 credits once with exactly 365 days, including leap years', () => {
        const free = { ...input, sku: 'free_v3' as const, subscriptionId: null, invoiceId: null, periodEnd: null,
            periodStart: new Date('2024-02-29T12:00:00Z') };
        expect(aiCreditEntitlement(free)).toEqual({ entitlementId: 'ezil-os:v1:free-once:user', credits: 100,
            expiresAt: '2025-02-28T12:00:00.000Z' });
        expect(aiCreditEntitlement({ ...free, periodStart: input.periodStart }).entitlementId).toBe('ezil-os:v1:free-once:user');
        expect(aiCreditEntitlement({ ...free, userId: 'other' }).entitlementId).not.toBe(aiCreditEntitlement(free).entitlementId);
    });
    it.each([{ subscriptionId: 'other' }, { sku: 'premium_monthly_v3' as const }, { periodStart: new Date('2026-10-02Z') }])
    ('isolates distinct paid entitlements %j', change => {
        expect(aiCreditEntitlement({ ...input, ...change }).entitlementId).not.toBe(aiCreditEntitlement(input).entitlementId);
    });
    it.each([{ userId: '' }, { periodStart: new Date('invalid') }, { periodEnd: null }, { periodEnd: new Date('invalid') },
        { periodEnd: input.periodStart }, { subscriptionId: null }, { invoiceId: null }])('rejects invalid grant inputs %j', change => {
        expect(() => aiCreditEntitlement({ ...input, ...change })).toThrow(TypeError);
    });
});


describe('W0.3 canonical root event grammar', () => {
    const grant = aiTopupOutboxItem('user', { ...findPack('ai_pack_10_v1')!, aiCredits: 1234 }, 'pi_test', new Date('2027-01-01Z'))!;
    it('retains root terms and payer across dispute, refund, and restore events', () => {
        grant.payload.accountPublicId = 'frozen-account';
        for (const item of [aiCreditRevokeItem(grant, { type: 'dispute', id: 'dp_D' }),
            aiCreditRevokeItem(grant, { type: 'refund', id: 're_R' }), aiCreditRestoreItem(grant, 'dp_D')]) {
            expect(item.payload).toMatchObject({ entitlementId: grant.payload.entitlementId, credits: 1234,
                expiresAt: grant.payload.expiresAt, accountPublicId: 'frozen-account' });
            expect(parseAiCreditEventId(String(grant.payload.entitlementId), item.eventKey, String(item.payload.action))).not.toBeNull();
        }
        expect(aiCreditRestoreItem(grant, 'dp_D').eventKey).toBe(`${grant.payload.entitlementId}:restore:dp_D`);
    });
    it('requires the exact root and an exact single cause suffix; no substring or truncation', () => {
        const root = String(grant.payload.entitlementId);
        for (const key of [`other${root}:restore:dp_D`, `${root}x:restore:dp_D`, `${root}:restore:dp_D:extra`,
            `${root}:restore:`, `${root}:restore:dp_D/`, `${root}:restore:dp_D\n`]) {
            expect(parseAiCreditEventId(root, key, 'restore')).toBeNull();
        }
        const id = 'd'.repeat(200 - root.length - ':revoke:dispute:'.length);
        expect(aiCreditRevokeItem(grant, { type: 'dispute', id }).eventKey).toHaveLength(200);
        expect(() => aiCreditRevokeItem(grant, { type: 'dispute', id: id + 'x' })).toThrow();
        expect(parseAiCreditEventId(root, `${root}:revoke`, 'revoke')).toEqual({ action: 'revoke' });
    });
});

describe('round 3 D1 upgrade entitlement', () => {
    const base = { userId: 'user', subscriptionId: 'sub_1Q2w3E4r5T6y7U8i', periodStart: input.periodStart, periodEnd: input.periodEnd,
        effectiveAt: new Date('2026-10-04T02:24:00.000Z') };
    it('builds the pinned id, prorated credits and periodEnd + 3 d expiry, and round-trips through the parsers', () => {
        const entitlement = aiUpgradeEntitlement(base);
        expect(entitlement).toEqual({ entitlementId: 'ezil-os:v1:premium_monthly_v3:sub_1Q2w3E4r5T6y7U8i:2026-10-04T02:24:00.000Z:upgrade',
            credits: 720, expiresAt: '2026-11-04T00:00:00.000Z' }); // floor(800 × 2,410,560 / 2,678,400)
        expect(parseAiUpgradeEntitlement(entitlement.entitlementId)).toEqual({ subscriptionId: base.subscriptionId, effectiveAt: base.effectiveAt });
        const grant = aiCreditOutboxItem('user', entitlement, 'grant', 'in_upgrade');
        expect(parseAiCreditEventId(entitlement.entitlementId, grant.eventKey, 'grant')).toEqual({ action: 'grant' });
        const revoke = aiCreditRevokeItem(grant, { type: 'refund', id: 're_1Q2w3E4r5T6y7U8iAbCdEfGh' });
        expect(parseAiCreditEventId(entitlement.entitlementId, revoke.eventKey, 'revoke')).toEqual({ action: 'revoke', cause: 'refund', causeId: 're_1Q2w3E4r5T6y7U8iAbCdEfGh' });
        expect(parseAiCreditEventId(entitlement.entitlementId, aiCreditRestoreItem(grant, 'dp_1').eventKey, 'restore')).toMatchObject({ action: 'restore' });
        expect(parseAiCreditEventId(entitlement.entitlementId, `${entitlement.entitlementId}:upgrade:grant`, 'grant')).toBeNull();
    });
    it('rejects invalid instants and ids instead of truncating them', () => {
        expect(() => aiUpgradeEntitlement({ ...base, effectiveAt: input.periodEnd })).toThrow(TypeError);
        expect(() => aiUpgradeEntitlement({ ...base, effectiveAt: new Date('2026-09-30T23:59:59.000Z') })).toThrow(TypeError);
        expect(() => aiUpgradeEntitlement({ ...base, subscriptionId: 'sub:other' })).toThrow(TypeError);
        expect(() => aiUpgradeEntitlement({ ...base, subscriptionId: 's'.repeat(131) })).toThrow(TypeError);
        expect(aiUpgradeEntitlement({ ...base, subscriptionId: 's'.repeat(130) }).entitlementId).toHaveLength(193);
        expect(aiUpgradeEntitlement({ ...base, effectiveAt: new Date(input.periodEnd.getTime() - 1000) }).credits).toBe(0);
        expect(parseAiUpgradeEntitlement('ezil-os:v1:standard_monthly_v3:sub:2026-10-04T02:24:00.000Z:upgrade')).toBeNull();
        expect(parseAiUpgradeEntitlement('ezil-os:v1:premium_monthly_v3:sub:2026-02-30T00:00:00.000Z:upgrade')).toBeNull();
    });
});
