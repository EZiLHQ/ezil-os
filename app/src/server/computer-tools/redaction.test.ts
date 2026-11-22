import { describe, expect, it } from 'vitest';

import { commandPrefix, redactSecrets } from './redaction';

describe('command redaction', () => {
    it('redacts credential shapes while keeping paths and sha-like tokens intact', () => {
        expect(redactSecrets('git -C /srv/project log 1a2b3c4')).toBe('git -C /srv/project log 1a2b3c4');
        expect(redactSecrets(`export GITHUB_TOKEN=ghp_${'a'.repeat(36)}`)).not.toContain('ghp_');
        expect(redactSecrets(`curl -H "Authorization: Bearer ${'A'.repeat(40)}"`)).toContain('Bearer <redacted>');
        expect(redactSecrets(`echo sk-ant-${'x'.repeat(24)}`)).toContain('<redacted>');
        expect(redactSecrets('API_KEY=supersecretvalue')).toBe('API_KEY=<redacted>');
    });

    it('redacts explicitly supplied secret values (≥8 chars)', () => {
        const secret = 'topsecretvalue1234';
        const out = redactSecrets(`deploy --key ${secret}`, [secret]);
        expect(out).not.toContain(secret);
        expect(out).toContain('<redacted>');
        // positive control: a short known value is not treated as a secret
        expect(redactSecrets('run abc', ['abc'])).toBe('run abc');
    });

    it('bounds the prefix to 120 chars and redacts BEFORE truncating', () => {
        expect(commandPrefix(`echo ${'y'.repeat(300)}`).length).toBe(120);
        const secret = `ghp_${'z'.repeat(36)}`; // 40 chars
        const cmd = `${'x'.repeat(100)} ${secret}`; // the secret straddles the 120-char cut
        expect(commandPrefix(cmd)).not.toContain('ghp_');
    });
});
