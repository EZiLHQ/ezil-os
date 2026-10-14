/**
 * P1: lifecycle callers go through `ComputeProvider`, never the Cloudflare
 * `request*` lifecycle functions directly — otherwise per-computer placement
 * (P3) would have a path that silently bypasses it.
 *
 * Static, and over the PARSED source rather than a text grep: comments in
 * these files legitimately name the functions they used to call, and only an
 * identifier that is code should fail this.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../..');

/** The lifecycle half of `cloudflare-guacamole-provider.ts`. Desktop-control
 *  calls (focus, screen, relay) are deliberately NOT here. */
const LIFECYCLE_FUNCTIONS = [
    'requestGuacamolePreview',
    'getGuacamoleSandboxStatus',
    'requestGuacamoleActivity',
    'requestGuacamoleDesktopRestart',
    'requestGuacamoleSandboxTerminate',
];

const CALLERS = [
    'server/api/routers/cloudflare-guacamole.ts',
    'server/api/routers/computer.ts',
    'server/api/routers/compute-dispatch.ts',
    'app/api/cron/sandbox-reap/route.ts',
    'app/api/cron/sandbox-reap/handler.ts',
];

/**
 * P3: the routers pick a provider PER COMPUTER, only through `routeComputer`
 * (`server/api/routers/compute-dispatch.ts`). A router that named a selector or
 * an adapter directly would have a path that ignores the computer's placement.
 */
const ROUTERS = ['server/api/routers/cloudflare-guacamole.ts', 'server/api/routers/computer.ts'];
const DIRECT_SELECTORS = [
    'selectComputeProvider',
    'resolveComputeProvider',
    'providerForPlacement',
    'cloudflareComputeProvider',
    'createCloudflareComputeProvider',
    'createAwsEc2Provider',
];

function identifiersIn(relPath: string): Set<string> {
    const file = path.join(SRC, relPath);
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const found = new Set<string>();
    const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node)) found.add(node.text);
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

describe('lifecycle callers use the ComputeProvider seam', () => {
    it.each(CALLERS)('%s names no Cloudflare lifecycle function', (relPath) => {
        const ids = identifiersIn(relPath);
        expect(LIFECYCLE_FUNCTIONS.filter((name) => ids.has(name))).toEqual([]);
    });

    it.each(ROUTERS)('%s selects a provider only through routeComputer (P3)', (relPath) => {
        const ids = identifiersIn(relPath);
        expect(DIRECT_SELECTORS.filter((name) => ids.has(name))).toEqual([]);
        expect(ids.has('routeComputer')).toBe(true);
    });

    it('the check can see a real identifier (guards against a vacuous pass)', () => {
        expect(identifiersIn('server/lib/compute/cloudflare.ts').has('requestGuacamolePreview')).toBe(true);
        expect(identifiersIn('server/api/routers/compute-dispatch.ts').has('selectComputeProvider')).toBe(true);
        expect(identifiersIn('server/api/routers/compute-dispatch.ts').has('resolveComputeProvider')).toBe(true);
        expect(identifiersIn('app/api/cron/sandbox-reap/route.ts').has('createCloudflareComputeProvider')).toBe(true);
    });
});
