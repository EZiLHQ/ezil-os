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
    it.each(['previewUrl', 'codePreviewUrl'])('%s pushes the AI credential before the AWS branch returns', name => {
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
