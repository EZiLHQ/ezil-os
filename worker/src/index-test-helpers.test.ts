/** Test-only access to private helpers; the boot test uses the real entrypoint. */
import { mock } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

mock.module('cloudflare:workers', () => ({
  DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {},
}));

// Preserve production bodies byte-for-byte. Only resolve module specifiers for
// the temporary test module and append the helper exports needed by existing tests.
let source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ESNext, true);
for (const statement of [...parsed.statements].reverse()) {
  if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
  const specifier = statement.moduleSpecifier;
  if (!specifier || !ts.isStringLiteral(specifier)) continue;
  source = source.slice(0, specifier.getStart(parsed)) +
    JSON.stringify(import.meta.resolve(specifier.text)) + source.slice(specifier.end);
}
source += `\nexport {
  codePreviewFolderParams, ensureWorkspaceMount, classifyFinalSystemCheckpoint,
  workspaceFlushLoopIsAlive, isIdleStopDue, parseLoadAvg1, containerBusyFromProbe,
  computeNextFlushBackoffSeconds, computeActivityTimestamp, validateActivityBody,
  resolveNekoIceEnv,
};`;
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

const directory = mkdtempSync(join(tmpdir(), 'ezil-worker-test-'));
const modulePath = join(directory, 'index.mjs');
let helpers;
try {
  writeFileSync(modulePath, compiled);
  helpers = await import(pathToFileURL(modulePath).href);
} finally {
  rmSync(directory, { recursive: true, force: true });
}

export const {
  codePreviewFolderParams, ensureWorkspaceMount, classifyFinalSystemCheckpoint,
  workspaceFlushLoopIsAlive, isIdleStopDue, parseLoadAvg1, containerBusyFromProbe,
  computeNextFlushBackoffSeconds, computeActivityTimestamp, validateActivityBody,
  resolveNekoIceEnv,
} = helpers;
