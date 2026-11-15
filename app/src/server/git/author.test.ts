import { describe, expect, it } from 'vitest';
import { gitAuthorFromVerifiedClaims, isGitAuthor } from './author';

describe('verified Git author', () => {
    it('uses the signed name and verified email, or the email local part', () => {
        expect(gitAuthorFromVerifiedClaims({ email: 'contact@ezil.work', email_verified: true, name: ' EZiL Contact ' }))
            .toEqual({ name: 'EZiL Contact', email: 'contact@ezil.work' });
        expect(gitAuthorFromVerifiedClaims({ email: 'contact@ezil.work', email_verified: true }))
            .toEqual({ name: 'contact', email: 'contact@ezil.work' });
    });
    it.each([undefined, false, 'true', 1])('never accepts email_verified=%j', email_verified => {
        expect(gitAuthorFromVerifiedClaims({ email: 'contact@ezil.work', email_verified })).toBeUndefined();
    });
    it.each(['not-an-email', 'a@b\nInjected', 'a<name>@b', `${'a'.repeat(250)}@b.test`])('refuses unsafe email %j', email => {
        expect(gitAuthorFromVerifiedClaims({ email, email_verified: true })).toBeUndefined();
    });
    it.each(['', 'Bad\nName', '<Bad>', 'x'.repeat(129)])('uses the local part for unsafe or missing name %j', name => {
        expect(gitAuthorFromVerifiedClaims({ email: 'contact@ezil.work', email_verified: true, name }))
            .toEqual({ name: 'contact', email: 'contact@ezil.work' });
    });
    it('checks the exact signed transport shape and Git ident delimiters', () => {
        expect(isGitAuthor({ name: 'Contact', email: 'contact@ezil.work' })).toBe(true);
        for (const author of [null, [], { name: 'Contact', email: 'contact@ezil.work', token: 'secret' },
            { name: 'Contact\nInjected', email: 'contact@ezil.work' }, { name: 'Contact', email: 'a@b>' }]) {
            expect(isGitAuthor(author)).toBe(false);
        }
    });
});
