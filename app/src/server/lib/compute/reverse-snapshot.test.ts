/**
 * REVERSE-MOVE-CONTRACT §7.2: the v1 seam. DECISION_72 holds lane O, so
 * `advanceReverseSnapshots` answers `held`/`v1_dlm` and does nothing else: no
 * table, no AWS, no log, no throw (§7.1: the D21 snapshot is the existing DLM
 * policy in v1). The static case pins that over the PARSED source, so a store
 * call or a log line added before lane O's contract revision (§7.3) fails here.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as seam from './reverse-snapshot';
import { advanceReverseSnapshots, type ReverseSnapshotPass } from './reverse-snapshot';

const SOURCE = path.join(__dirname, 'reverse-snapshot.ts');
const HELD: ReverseSnapshotPass = { status: 'held', reason: 'v1_dlm' };

/** Code identifiers that would mean I/O, a clock, a log or a store call. */
const FORBIDDEN = new Set([
    'console', 'fetch', 'process', 'globalThis', 'Date', 'setTimeout', 'setInterval', 'require',
    'createProviderReverseStore', 'listUnsnapshotted', 'listRetentionExpired', 'recordSnapshot', 'markSnapshotSpent',
]);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('advanceReverseSnapshots: the v1 seam (§7.2, DECISION_72)', () => {
    it('answers held / v1_dlm, as a promise', async () => {
        const pending = advanceReverseSnapshots({ deadlineMs: Date.now() + 20_000 });
        expect(pending).toBeInstanceOf(Promise);
        await expect(pending).resolves.toStrictEqual(HELD);
    });

    it('never throws, whatever the deadline: past, zero, negative, NaN, infinite', async () => {
        for (const deadlineMs of [Date.now() - 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            await expect(advanceReverseSnapshots({ deadlineMs })).resolves.toStrictEqual(HELD);
        }
    });

    it('logs nothing and fetches nothing', async () => {
        const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m));
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await advanceReverseSnapshots({ deadlineMs: 0 });
        for (const spy of logs) expect(spy).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('exports the seam and nothing else at runtime', () => {
        expect(Object.keys(seam).sort()).toEqual(['advanceReverseSnapshots']);
    });

    it('🔴 imports nothing, throws nothing, names no clock, log, network or store identifier (parsed)', () => {
        const source = ts.createSourceFile(SOURCE, readFileSync(SOURCE, 'utf8'), ts.ScriptTarget.Latest, true);
        const imports: string[] = [];
        const throws: string[] = [];
        const named: string[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) imports.push(node.getText(source));
            if (ts.isExportDeclaration(node) && node.moduleSpecifier) imports.push(node.getText(source));
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) imports.push(node.getText(source));
            if (ts.isThrowStatement(node)) throws.push(node.getText(source));
            if (ts.isIdentifier(node) && FORBIDDEN.has(node.text)) named.push(node.text);
            ts.forEachChild(node, visit);
        };
        visit(source);

        // Guards a vacuous pass: the parse saw the seam itself.
        expect(source.statements.length).toBeGreaterThanOrEqual(2);
        expect(imports).toEqual([]);
        expect(throws).toEqual([]);
        expect(named).toEqual([]);
    });
});
