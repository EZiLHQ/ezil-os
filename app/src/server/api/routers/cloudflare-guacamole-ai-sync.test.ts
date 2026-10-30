import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cloudflare-guacamole.ts'), 'utf8');
const block = (name: string) => {
    const start = source.indexOf(`${name}: protectedProcedure`);
    expect(start).toBeGreaterThan(-1);
    const next = source.indexOf(': protectedProcedure', start + name.length + 20);
    return source.slice(start, next === -1 ? undefined : next);
};

describe('EZiL Chat credentials reach AWS computers too', () => {
    // WARM-118: codePreviewUrl overlaps the sync with the AWS ensure (behaviour: cloudflare-guacamole-warm-overlap.test.ts).
    it('codePreviewUrl syncs after the billing gate, settles sync AND ensure before any AWS preview, and keeps Cloudflare sync-first', () => {
        const body = block('codePreviewUrl');
        const sync = body.indexOf('syncAiCredential(');
        const aws = body.indexOf("if (routed.kind === 'aws-ec2')");
        expect(body.indexOf('gateComputerStart(')).toBeLessThan(sync);
        expect(sync).toBeLessThan(aws);
        const awsBranch = body.slice(aws, body.indexOf('awsPreviewAnswer(', aws));
        expect(awsBranch).toMatch(/await Promise\.allSettled\(\[routed\.provider\.ensure\([^)]*\), syncCredential\(\)\]\)/);
        const cf = body.indexOf('await syncCredential();');
        expect(cf).toBeGreaterThan(aws);
        expect(cf).toBeLessThan(body.indexOf('const result = await routed.provider.ensure(', cf));
    });

    it.each(['previewUrl'])('%s pushes the AI credential before the AWS branch returns', name => {
        const body = block(name);
        const sync = body.indexOf('await syncAiCredential(');
        const aws = body.indexOf("if (routed.kind === 'aws-ec2')");
        expect(sync).toBeGreaterThan(-1);
        expect(aws).toBeGreaterThan(-1);
        expect(sync).toBeLessThan(aws);
        // Billing admission still runs first.
        expect(body.indexOf('gateComputerStart(')).toBeLessThan(sync);
    });

    it('activity reporting refreshes the AI credential for every provider', () => {
        const body = block('reportActivity');
        expect(body).toContain('await syncAiCredential(');
        expect(body).not.toMatch(/if \(routed\.kind !== 'aws-ec2'\) \{\s*await syncAiCredential/);
    });
});
