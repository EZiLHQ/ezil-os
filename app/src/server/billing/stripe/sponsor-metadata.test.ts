import { describe, expect, it } from 'vitest';
import { trialSubscriptionData } from './client';

const TRIAL = { trialId: '11111111-1111-4111-8111-111111111111', trialEnd: new Date('2026-12-12T10:00:00Z') };

describe('sponsor trial metadata on the subscription (server-written, deterministic per quote)', () => {
    it('is absent for a public trial, so existing parameters and idempotency are unchanged', () => {
        const data = trialSubscriptionData('standard_monthly_v3', TRIAL);
        expect(Object.keys(data.metadata)).not.toContain('ezil_sponsor_campaign');
        expect(Object.keys(data.metadata)).not.toContain('ezil_sponsor_config');
        expect(data.trial_settings).toEqual({ end_behavior: { missing_payment_method: 'cancel' } });
    });
    it('carries the campaign and frozen config hash for a sponsor trial and changes nothing else', () => {
        const plain = trialSubscriptionData('standard_monthly_v3', TRIAL);
        const sponsored = trialSubscriptionData('standard_monthly_v3', { ...TRIAL, sponsor: { campaignId: 'test-campaign-a', configSha256: 'a'.repeat(64) } });
        expect(sponsored.metadata).toEqual({ ...plain.metadata, ezil_sponsor_campaign: 'test-campaign-a', ezil_sponsor_config: 'a'.repeat(64) });
        expect(sponsored.trial_end).toBe(plain.trial_end);
        expect(sponsored.trial_settings).toEqual(plain.trial_settings);
        expect(trialSubscriptionData('standard_monthly_v3', { ...TRIAL, sponsor: { campaignId: 'test-campaign-a', configSha256: 'a'.repeat(64) } })).toEqual(sponsored);
    });
});
