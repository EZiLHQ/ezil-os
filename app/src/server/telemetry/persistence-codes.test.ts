import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { PERSISTENCE_OK_CODES, PERSISTENCE_PAUSE_CODES } from './queries';

// Read cross-runtime sources as text: importing the worker or shell would
// couple app tests to Cloudflare/browser globals and their dependency graphs.
const worker = readFileSync(path.resolve(__dirname, '../../../../worker/src/persistence-telemetry.ts'), 'utf8');
const shell = readFileSync(path.resolve(__dirname, '../../../../shell/ezil/apps/persistence-status.js'), 'utf8');
const appSchema = readFileSync(path.resolve(__dirname, '../lib/cloudflare-guacamole-provider.ts'), 'utf8');

function codesFrom(source: string, pattern: RegExp): string[] {
    const match = source.match(pattern);
    expect(match, `Missing code list matching ${pattern}`).not.toBeNull();
    const entries = match![1]!.split(',').map(entry => entry.trim()).filter(Boolean);
    // null means "pause cleared", not a reason code. Reject non-literals so
    // changing a declaration cannot silently weaken this text-only check.
    for (const entry of entries) expect(entry).toMatch(/^(?:null|'[a-z0-9_]+'|"[a-z0-9_]+")$/);
    return entries.filter(entry => entry !== 'null').map(entry => entry.slice(1, -1)).sort();
}

function setCodes(source: string, name: string): string[] {
    return codesFrom(source, new RegExp(`\\bconst ${name}(?:\\s*:[^=]+)?\\s*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`));
}

describe('persistence code lists agree across runtimes', () => {
    it('matches the worker OK outcome codes used by the rollup query', () => {
        expect(setCodes(worker, 'OK_CODES')).toEqual([...PERSISTENCE_OK_CODES].sort());
    });

    it('matches the worker pause codes used by persistence health', () => {
        expect(setCodes(worker, 'SYSTEM_PAUSE_CODES')).toEqual([...PERSISTENCE_PAUSE_CODES].sort());
    });

    it('matches shell pause reasons, excluding the null clear state', () => {
        expect(setCodes(shell, 'PAUSED_REASONS')).toEqual([...PERSISTENCE_PAUSE_CODES].sort());
    });

    it('matches the app status schema pause reasons', () => {
        expect(codesFrom(appSchema, /pausedReason:\s*z\.enum\(\[([\s\S]*?)\]\)/))
            .toEqual([...PERSISTENCE_PAUSE_CODES].sort());
    });
});
