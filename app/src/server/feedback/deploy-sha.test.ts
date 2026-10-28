import { describe, expect, it } from 'vitest';

import { deploySha } from './deploy-sha';

describe('deploySha — the commit stamped on each feedback report', () => {
    it('prefers EZIL_GIT_SHA (the image build arg), then the Vercel commit', () => {
        expect(deploySha({ EZIL_GIT_SHA: '46698745a1b2c3d4e5f60718293a4b5c6d7e8f90', VERCEL_GIT_COMMIT_SHA: 'abcdef1' })).toBe('46698745a1b2c3d4e5f60718293a4b5c6d7e8f90');
        expect(deploySha({ EZIL_GIT_SHA: '', VERCEL_GIT_COMMIT_SHA: 'abcdef1' })).toBe('abcdef1');
    });
    it('accepts a SHA-256 object id too', () => {
        expect(deploySha({ EZIL_GIT_SHA: 'a'.repeat(64) })).toBe('a'.repeat(64));
    });
    it.each([{}, { EZIL_GIT_SHA: 'sk_test_not-a-sha' }, { EZIL_GIT_SHA: 'ABCDEF1' }, { EZIL_GIT_SHA: 'abc12' }, { EZIL_GIT_SHA: 'a'.repeat(65) }])(
        'is null for a missing or non-SHA value %j', (envIn) => {
            expect(deploySha(envIn)).toBeNull();
        });
});
