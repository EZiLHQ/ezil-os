import { describe, expect, it } from 'vitest';

import { isTelemetryAdmin } from './admin';

describe('isTelemetryAdmin: fails closed', () => {
    it('denies everyone when the allow-list is unset', () => {
        expect(isTelemetryAdmin('owner@ezil.work', undefined)).toBe(false);
    });

    it('denies everyone when the allow-list is empty/whitespace', () => {
        expect(isTelemetryAdmin('owner@ezil.work', '   ')).toBe(false);
        expect(isTelemetryAdmin('owner@ezil.work', ',,,')).toBe(false);
    });

    it('denies a signed-out caller (no email) even with a configured allow-list', () => {
        expect(isTelemetryAdmin(null, 'owner@ezil.work')).toBe(false);
        expect(isTelemetryAdmin(undefined, 'owner@ezil.work')).toBe(false);
    });

    it('allows an exact match, case-insensitively', () => {
        expect(isTelemetryAdmin('Owner@Ezil.Work', 'owner@ezil.work')).toBe(true);
    });

    it('allows a match among a comma-separated, whitespace-padded list', () => {
        expect(isTelemetryAdmin('b@ezil.work', ' a@ezil.work, b@ezil.work ,c@ezil.work')).toBe(true);
    });

    it('denies anyone not on the list', () => {
        expect(isTelemetryAdmin('stranger@example.com', 'owner@ezil.work')).toBe(false);
    });
});
