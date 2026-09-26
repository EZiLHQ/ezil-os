import { describe, expect, it } from 'vitest';
import { configurationMountConfirmed } from './configuration-mount';

describe('configuration mount revocation exemption', () => {
    const check = (configuration: string) => configurationMountConfirmed(null as never, { configuration } as never);
    it('allows an explicitly suspended empty configuration without mount records', async () => {
        expect(await check(JSON.stringify({ suspended: true, preparedInstallations: [], approvedInstallations: [] }))).toBe(true);
    });
    it.each([
        { suspended: true, preparedInstallations: [{}], approvedInstallations: [] },
        { suspended: true, preparedInstallations: [], approvedInstallations: [{}] },
        { suspended: true }, { suspended: 'true', preparedInstallations: [], approvedInstallations: [] },
        { preparedInstallations: [], approvedInstallations: [] }, null,
    ])('rejects incomplete or authority-bearing suspension: %j', async input => {
        expect(await check(JSON.stringify(input))).toBe(false);
    });
    it('rejects malformed stored data without echoing it in an error', async () => {
        expect(await check('sensitive-input-sentinel')).toBe(false);
    });
});
