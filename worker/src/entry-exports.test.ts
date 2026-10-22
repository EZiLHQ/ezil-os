import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const entryPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const configPath = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
// ContainerProxy is the SDK's R2-egress WorkerEntrypoint, referenced dynamically
// by Sandbox. The other names come directly from Wrangler's DO bindings.
const expectedClasses = [
  ...new Set([...readFileSync(configPath, 'utf8').matchAll(/^class_name\s*=\s*"([^"]+)"/gm)]
    .map((match) => match[1])),
  'ContainerProxy',
].sort();

/** Resolve aliases/re-exports without executing index.ts or loading workerd. */
function inspectExports(source = readFileSync(entryPath, 'utf8')) {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noLib: true,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === entryPath
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([entryPath], options, host);
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(entryPath)!)!;
  const values: string[] = [];
  const invalid: string[] = [];
  for (const exported of checker.getExportsOfModule(module)) {
    // A type-only class re-export is erased too, despite its target being a value.
    if (exported.declarations?.every((declaration) =>
      ts.isExportSpecifier(declaration) &&
      (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly),
    )) continue;
    const target = exported.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(exported)
      : exported;
    if (!(target.flags & ts.SymbolFlags.Value) && target.declarations?.length) continue;
    const name = exported.getName();
    values.push(name);
    if (name === 'default') continue;
    if (!expectedClasses.includes(name) ||
      !target.declarations?.some(ts.isClassDeclaration)) invalid.push(name);
  }
  return { values: values.sort(), invalid: invalid.sort() };
}

describe('Worker entry module exports', () => {
  it('exports only the default handler and the bound Durable Object/WorkerEntrypoint classes', () => {
    expect(inspectExports()).toEqual({
      values: [...expectedClasses, 'default'].sort(),
      invalid: [],
    });
  });

  it.each([
    ['constant declaration', 'export const ACCEPTANCE_RESET_DELAY_MS = 100;'],
    ['local alias', 'const delay = 100; export { delay as ACCEPTANCE_RESET_DELAY_MS };'],
    ['constant re-export', "export { ACCEPTANCE_RESET_DELAY_MS } from './acceptance-config';"],
    ['wildcard re-export', "export * from './acceptance-config';"],
    ['namespace re-export', "export * as config from './acceptance-config';"],
    ['helper function', 'export function helper() {}'],
    ['function re-export', "export { portFor } from './desktop-mode';"],
    ['enum', 'export enum Mode { Active }'],
    ['unbound class', 'export class Unbound {}'],
    ['value using a bound name', 'export const Sandbox = {};'],
    ['unresolved re-export', "export { missing } from './acceptance-config';"],
  ])('rejects a %s', (_label, source) => {
    expect(inspectExports(source).invalid.length).toBeGreaterThan(0);
  });

  it('allows the default handler, aliased classes and erased types', () => {
    expect(inspectExports(`
      class Implementation {}
      export { Implementation as Sandbox };
      export { AwsTunnelRegistry } from './aws-tunnels';
      export { ContainerProxy } from '@cloudflare/sandbox';
      export type { AcceptanceFaultState } from './acceptance-faults';
      export type { AwsTunnelRegistry as RegistryType } from './aws-tunnels';
      export interface Config { delay: number }
      export type Mode = 'active';
      export default { fetch() { return new Response('ok'); } };
    `)).toEqual({ values: [...expectedClasses, 'default'].sort(), invalid: [] });
  });
});
