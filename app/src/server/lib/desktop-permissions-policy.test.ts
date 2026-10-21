import { describe, expect, it } from 'vitest';
import config from '../../../next.config';

describe('desktop Permissions-Policy', () => {
    it('delegates read and write to production and staging desktop origins for both providers', async () => {
        const rules = await config.headers!();
        const rule = rules.find(r => r.source === '/:path*');
        const policy = rule?.headers.find(h => h.key === 'Permissions-Policy')?.value;
        expect(policy).toBeDefined();
        for (const feature of ['clipboard-read', 'clipboard-write']) {
            expect(policy).toContain(`${feature}=(self "https://*.ezil.org" "https://*.ezil.work")`);
        }
        expect(policy).not.toContain('=(*)');
        expect(policy).not.toContain('http:');
    });
});
