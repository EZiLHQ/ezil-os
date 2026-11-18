/**
 * `standaloneGitUrlEnabled` against closed environments (only `BILLING_FUNDING_URL`, never `process.env`):
 * the two canonical funding roots, bare or with one root slash, enable the direct Git URL route; every
 * other value fails closed. `awsStandaloneGitEnabled` is unchanged and independent of it.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { awsStandaloneGitEnabled, standaloneGitUrlEnabled } from './staging';

const funding = (value: unknown) => ({ BILLING_FUNDING_URL: value as string | undefined });

describe('standaloneGitUrlEnabled: a closed table of canonical funding roots', () => {
    it.each([
        'https://ai-staging.ezil.work', 'https://ai-staging.ezil.work/',
        'https://ai.ezil.work', 'https://ai.ezil.work/',
    ])('enables %s', value => expect(standaloneGitUrlEnabled(funding(value))).toBe(true));

    it.each([
        // missing / empty / blank
        undefined, '', ' ', '\t',
        // whitespace around a canonical root is never trimmed into acceptance
        ' https://ai.ezil.work', 'https://ai.ezil.work ', 'https://ai.ezil.work\n', '\thttps://ai-staging.ezil.work/',
        // more than one root slash, a path, query or hash
        'https://ai.ezil.work//', 'https://ai-staging.ezil.work//', 'https://ai.ezil.work/v1', 'https://ai-staging.ezil.work/funding',
        'https://ai.ezil.work?x=1', 'https://ai.ezil.work/?x', 'https://ai.ezil.work#x', 'https://ai-staging.ezil.work/#',
        // userinfo, any explicit port (the default one included), http, case
        'https://u@ai.ezil.work', 'https://u:p@ai-staging.ezil.work/', 'https://ai.ezil.work:443', 'https://ai-staging.ezil.work:443/',
        'https://ai.ezil.work:8443', 'http://ai.ezil.work', 'http://ai-staging.ezil.work/', 'HTTPS://ai.ezil.work', 'https://AI.EZIL.WORK',
        // look-alikes and other EZiL origins
        'https://ai.ezil.work.evil.com', 'https://evil.com/https://ai.ezil.work', 'https://xai.ezil.work', 'https://ai-staging2.ezil.work',
        'https://ai.ezil.works', 'https://ai.ezil.work.', 'https://ezil.work', 'https://os.ezil.work', 'https://ai-qa.ezil.work',
        // malformed
        'not a url', 'ai.ezil.work', '//ai.ezil.work', 'https://', 'https:ai.ezil.work',
    ])('fails closed for %j', value => expect(standaloneGitUrlEnabled(funding(value))).toBe(false));

    it('fails closed for an absent key and for non-string values', () => {
        expect(standaloneGitUrlEnabled({})).toBe(false);
        for (const value of [42, null, ['https://ai.ezil.work'], { toString: () => 'https://ai.ezil.work' }]) {
            expect(standaloneGitUrlEnabled(funding(value))).toBe(false);
        }
    });

    it('reads only the funding URL: unrelated billing or AWS settings neither enable nor disable it', () => {
        const unrelated = { BILLING_FUNDING_HMAC_SECRET: 's', CHECKOUT_ENABLED: '1', AWS_STANDALONE_REPO_OPEN_ENABLED: '1' };
        expect(standaloneGitUrlEnabled({ ...unrelated })).toBe(false);
        expect(standaloneGitUrlEnabled({ ...unrelated, BILLING_FUNDING_URL: 'https://ai.ezil.work' })).toBe(true);
        expect(standaloneGitUrlEnabled({ ...unrelated, BILLING_FUNDING_URL: 'https://ai.ezil.work:443' })).toBe(false);
    });
});

describe('awsStandaloneGitEnabled: unchanged and independent of the funding root', () => {
    it.each(['1', 'true', 'on', 'TRUE', ' on '])('enables %j', value =>
        expect(awsStandaloneGitEnabled({ AWS_STANDALONE_REPO_OPEN_ENABLED: value })).toBe(true));
    it.each([undefined, '', '0', 'false', 'off', 'yes', 'enabled'])('stays off for %j', value =>
        expect(awsStandaloneGitEnabled({ AWS_STANDALONE_REPO_OPEN_ENABLED: value })).toBe(false));
    it('a canonical funding root does not enable it', () =>
        expect(awsStandaloneGitEnabled({ BILLING_FUNDING_URL: 'https://ai.ezil.work' })).toBe(false));
});
