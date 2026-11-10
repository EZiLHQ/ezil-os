import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import fixtures from '../../app/src/server/feedback/app-failures.fixtures.json';
import { codeShellOriginsFor, injectCodeFolderBridge } from './code-folder-bridge';
import { codeDiagBridgeScript, DIAG_BRIDGE_MARKER, injectCodeDiagBridge } from './code-diag-bridge';

const SHELL = 'https://os-staging.ezil.work';
const OTHER = 'https://other.ezil.work';
const PROD = 'https://os.ezil.work';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const hello = { type: 'ezil.code.diag.hello', v: 1, nonce: NONCE };
const record = fixtures.valid[0]!.failure;
const ready = { type: 'ezil.code.diag.ready', v: 1, nonce: NONCE };
const substitute = (value: unknown): any => JSON.parse(JSON.stringify(value), (_key, item) =>
  item === '$NONCE' ? NONCE : item === '$VALID_0' ? record : item);
type Posted = { message: Record<string, unknown>; origin: string };

function run({ framed = true, origins = [SHELL], encodedSize, throws = false }:
  { framed?: boolean; origins?: string[]; encodedSize?: number; throws?: boolean } = {}) {
  let now = 0;
  const posted: Posted[] = [];
  const listeners: Record<string, Array<(event: any) => void>> = {};
  const parent = { postMessage(message: Record<string, unknown>, origin: string) {
    if (throws) throw new Error('unavailable');
    posted.push({ message: structuredClone(message), origin });
  } };
  const window: Record<string, any> = {
    parent, addEventListener(type: string, fn: (event: any) => void) { (listeners[type] ??= []).push(fn); },
    dispatchEvent(event: { type: string }) { for (const fn of listeners[event.type] ?? []) fn(event); },
  };
  if (!framed) window.parent = window;
  const context = { window, Date: { now: () => now }, TextEncoder: encodedSize === undefined ? TextEncoder :
    class { encode() { return { byteLength: encodedSize }; } } };
  const globals = Object.keys(context);
  runInNewContext(codeDiagBridgeScript(origins), context);
  expect(Object.keys(context)).toEqual(globals);
  const message = (data: unknown = hello, over: Record<string, unknown> = {}) =>
    window.dispatchEvent({ type: 'message', source: parent, origin: SHELL, data, ...over });
  const raw = (detail: unknown) => window.dispatchEvent({ type: 'ezil-app-failure', detail });
  const failure = (r: unknown = record) => raw(JSON.stringify(r));
  return { posted, failures: () => posted.filter(p => p.message.type === 'ezil.code.failure'), listeners, message, raw, failure, window, advance: (ms: number) => { now += ms; } };
}

describe('diagnostic bridge handshake and limits', () => {
  it('is inert outside a frame or without pinned origins', () => {
    for (const options of [{ framed: false }, { origins: [] }]) {
      const b = run(options); b.message(); b.failure();
      expect(b.listeners).toEqual({}); expect(b.posted).toEqual([]);
    }
  });
  it('ignores wrong sources/origins, extra/missing keys, wrong type/version and malformed nonces', () => {
    const cases: Array<[unknown, Record<string, unknown>?]> = [
      [hello, { source: {} }], [hello, { origin: OTHER }], [hello, { origin: 'null' }],
      [{ ...hello, extra: true }], [{ type: hello.type, nonce: NONCE }], [{ ...hello, v: 2 }],
      [{ ...hello, type: 'ezil.code.hello' }], [null], ['hello'], [[]],
      ...['', 'a'.repeat(21), 'a'.repeat(23), `${NONCE}\n`, 'a'.repeat(21) + '+', 22].map(nonce => [{ ...hello, nonce }] as [unknown]),
    ];
    for (const [data, over] of cases) {
      const b = run(); b.failure(); b.message(data, over); b.failure();
      expect(b.posted).toEqual([]);
      b.message(); expect(b.posted).toHaveLength(3); // invalid hello did not flush or discard
    }
  });
  it('posts only canonical accepted envelopes, ready before failure, one ready per hello', () => {
    const b = run({ origins: [SHELL, OTHER] });
    b.failure(); b.message(substitute(fixtures.envelopes.hello));
    expect(b.posted).toEqual(fixtures.envelopes.accepted.map(e => ({ message: substitute(e.envelope), origin: SHELL })));
    for (const e of fixtures.envelopes.rejected) expect(b.posted.map(p => p.message)).not.toContainEqual(substitute(e.envelope));
    const nonce = 'BBBBBBBBBBBBBBBBBBBBBB';
    b.message({ ...hello, nonce }, { origin: OTHER }); b.failure();
    expect(b.posted.slice(2)).toEqual([
      { message: { ...ready, nonce }, origin: OTHER },
      { message: { type: 'ezil.code.failure', v: 1, nonce, failure: record }, origin: OTHER },
    ]);
    expect(b.posted.filter(p => p.message.type === ready.type)).toHaveLength(2);
  });
  it('queues before hello, dropping the oldest beyond ten; hello flushes only once in order', () => {
    const b = run();
    const records = Array.from({ length: 13 }, (_, i) => ({ ...record, attempt: i + 1 }));
    records.forEach(b.failure); expect(b.posted).toEqual([]);
    b.message(); expect(b.failures().map(p => p.message.failure)).toEqual(records.slice(3));
    b.message(); expect(b.posted).toHaveLength(12); // second hello gets a ready, no repeated failures
  });
  it('limits posts to twenty per rolling minute, including queued records; excess is dropped', () => {
    const b = run();
    for (let i = 0; i < 10; i++) b.failure();
    b.message(); b.advance(30_000);
    for (let i = 0; i < 15; i++) b.failure();
    expect(b.posted).toHaveLength(20);
    b.message({ ...hello, nonce: 'BBBBBBBBBBBBBBBBBBBBBB' });
    b.advance(29_999); b.failure(); expect(b.posted).toHaveLength(20);
    b.advance(1);
    for (let i = 0; i < 11; i++) b.failure();
    expect(b.posted).toHaveLength(31); // ready plus first ten failures expired
    b.advance(30_000); b.failure(); expect(b.posted).toHaveLength(32);
  });
  it('counts ready acknowledgements in the cap and rejects a hello when it cannot acknowledge it', () => {
    const b = run();
    for (let i = 0; i < 21; i++) b.message();
    expect(b.posted).toHaveLength(20);
    expect(b.posted.every(p => p.message.type === ready.type)).toBe(true);
    b.failure(); expect(b.failures()).toEqual([]);
    b.advance(60_000);
    const nonce = 'BBBBBBBBBBBBBBBBBBBBBB';
    b.message({ ...hello, nonce }); b.failure();
    expect(b.posted.slice(20).map(p => p.message.nonce)).toEqual([nonce, nonce]);
    expect(b.posted[20]!.message).toEqual({ ...ready, nonce });
  });
  it('checks the 2048-byte serialized envelope ceiling', () => {
    // Canonical field bounds currently keep valid records below 2048 bytes. Inject the encoder size to
    // exercise the envelope guard itself, independently of rejecting an overlong field at validation.
    for (const encodedSize of [2048, 2049]) {
      const b = run({ encodedSize }); b.message(); b.failure();
      expect(b.posted).toHaveLength(encodedSize === 2048 ? 2 : 0);
    }
    const b = run(); b.message(); b.failure({ ...record, modelKey: 'x'.repeat(3000) });
    expect(b.failures()).toHaveLength(0);
  });
  it('swallows malformed JSON, getters and postMessage errors, and keeps listening', () => {
    const b = run(); b.message();
    for (const detail of ['{', '', 'null', '[]', '{}', 1, record]) b.raw(detail);
    expect(() => b.window.dispatchEvent({ type: 'ezil-app-failure', get detail() { throw new Error('bad'); } })).not.toThrow();
    expect(() => b.message({ ...hello, get nonce() { throw new Error('bad'); } })).not.toThrow();
    expect(b.posted).toEqual([{ message: ready, origin: SHELL }]); b.failure(); expect(b.posted).toHaveLength(2);
    const broken = run({ throws: true }); broken.failure();
    expect(() => broken.message()).not.toThrow(); expect(() => broken.failure()).not.toThrow();
  });
});

describe('canonical app-failure fixtures', () => {
  for (const entry of fixtures.valid) it(`posts unchanged: ${entry.name}`, () => {
    const b = run(); b.message(); b.failure(entry.failure);
    expect(b.failures().map(p => p.message.failure)).toEqual([entry.failure]);
  });
  for (const entry of fixtures.rejected) it(`never queues or posts: ${entry.name}`, () => {
    const b = run(); b.failure(entry.failure); b.message(); b.failure(entry.failure);
    expect(b.posted).toEqual([{ message: ready, origin: SHELL }]);
  });
  it('rejects missing fields, prototype names, malformed types, bounds and non-neutral cancellation', () => {
    const invalid: unknown[] = [null, [], true];
    for (const key of ['eventId', 'source', 'operation', 'category', 'code', 'stage', 'outcome']) {
      const missing: Record<string, unknown> = { ...record }; delete missing[key]; invalid.push(missing);
    }
    for (const [key, values] of Object.entries({
      eventId: [`${record.eventId}\n`, record.eventId.toUpperCase(), 1],
      source: ['other', null], operation: ['other', null], stage: ['other', null], outcome: ['other', null],
      category: ['__proto__', 'constructor', 'other'], code: ['constructor', 'auth_invalid'],
      streamReason: ['other', null], retryable: [1, 'true'], attempt: [0, 65, 1.1, '1'],
      durationMs: [-1, 3600001, 0.1, '1'], httpStatus: [99, 600, 200.5, '200'],
      modelKey: ['', 'x'.repeat(65), 'model\n', 'https://example.test', 1],
      clientRequestId: ['bad', `${record.eventId}\n`], gatewayRequestId: ['bad'], vscodeRequestId: ['bad'], retryOfClientRequestId: ['bad'],
    })) for (const value of values) invalid.push({ ...record, [key]: value });
    const cancellation = fixtures.valid.find(e => e.failure.category === 'cancellation')!.failure;
    invalid.push({ ...cancellation, outcome: 'failed' });
    for (const failure of invalid) {
      const b = run(); b.message(); b.failure(failure); expect(b.failures()).toEqual([]);
    }
  });
  it('model-key decisions match the canonical function for namespaces, tokens, segments and boundaries', () => {
    const canonical = readFileSync(new URL('../../app/src/server/feedback/types.ts', import.meta.url), 'utf8');
    const snippet = canonical.slice(canonical.indexOf('const MODEL_KEY ='), canonical.indexOf('const appFailureId =')).replaceAll('export ', '');
    const server = runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(snippet) + ';isSafeModelKey');
    const script = codeDiagBridgeScript([SHELL]);
    const validator = script.split('// APP_FAILURE_VALIDATOR_BEGIN\n')[1]!.split('\n// APP_FAILURE_VALIDATOR_END')[0]!;
    const bridge = runInNewContext(validator + ';safeModelKey');
    const namespaces = runInNewContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(snippet) + ';MODEL_KEY_NAMESPACES');
    const candidates: unknown[] = [null, 1, '', 'https://openai/gpt-5', 'openai/gpt-5/x', 'openai/gpt-5\n',
      'unknown/model-1', 'openai/gpt', 'anthropic/' + 'model-'.repeat(8) + 'v12345', 'anthropic/' + 'model-'.repeat(8) + 'v123456'];
    for (const ns of namespaces) for (const model of ['model-1', 'model1', 'model', 'sk-x1', 'sb_x1', 'pk_x1', 'rk_x1',
      'ghp_x1', 'gho_x1', 'ghs_x1', 'ghu_x1', 'github_pat_x1', 'xoxa-x1', 'xoxb-x1', 'xoxp-x1', 'xoxr-x1',
      'model-secret-1', 'model-token-1', 'passw-1', 'bearer-1', 'api-key-1', 'api_key-1', 'apikey-1',
      'private-1', 'credential-1', 'session-1', 'cookie-1', 'a'.repeat(19) + '-1', 'a'.repeat(20) + '-1',
      'model-1:0', 'model-1..x', 'model-1.sk_x', 'model-1:token-1']) {
      candidates.push(`${ns}/${model}`, `${ns}.${model}`);
    }
    for (const value of candidates) expect(bridge(value)).toBe(server(value));
  });
  it('unexpected_error remains valid in every category, including neutral cancellation', () => {
    const failure = { ...fixtures.valid.find(e => e.failure.category === 'cancellation')!.failure, code: 'unexpected_error' };
    const b = run(); b.message(); b.failure(failure);
    expect(b.failures()[0]!.message.failure).toEqual(failure);
  });
  it('accepts all numeric boundaries and maximum model-key length', () => {
    for (const values of [{ attempt: 1, durationMs: 0, httpStatus: 100 }, { attempt: 64, durationMs: 3600000, httpStatus: 599 }]) {
      const b = run(); b.message(); const failure = { ...record, ...values, modelKey: 'anthropic/' + 'model-'.repeat(8) + 'v12345' };
      b.failure(failure); expect(b.failures()[0]!.message.failure).toEqual(failure);
    }
  });
});

describe('diagnostic script injection', () => {
  const html = '<html><head><meta charset="utf-8"><script nonce="12345678-abcd">start()</script></head><body></body></html>';
  it('uses the same head insertion point and nonce, independently of the folder bridge', () => {
    const folder = injectCodeFolderBridge(html, [SHELL]);
    const out = injectCodeDiagBridge(folder, [SHELL]);
    expect(out).toContain('<meta charset="utf-8">\n<script nonce="12345678-abcd" data-ezil-diag-bridge="1">');
    expect(out.replace(/\n<script nonce="[^"]*" data-ezil-diag-bridge="1">[\s\S]*?<\/script>/, '')).toBe(folder);
    expect(injectCodeDiagBridge(out, [SHELL])).toBe(out);
    expect(out.split(DIAG_BRIDGE_MARKER)).toHaveLength(2);
  });
  it('production (zone undefined or ezil.org) injects the bridge for the production origin only', () => {
    for (const zone of [undefined, 'ezil.org']) {
      const origins = codeShellOriginsFor(zone);
      expect(origins).toEqual([PROD]);
      const out = injectCodeDiagBridge(html, origins);
      expect(out).toContain('<meta charset="utf-8">\n<script nonce="12345678-abcd" data-ezil-diag-bridge="1">');
      expect(out).toContain(DIAG_BRIDGE_MARKER);
      expect(out).toContain(JSON.stringify([PROD]));
      expect(out).not.toContain('os-staging.ezil.work');
    }
    // The running production bridge accepts only the production origin: the default/staging origin posts nothing.
    const staging = run({ origins: codeShellOriginsFor(undefined) });
    staging.message(); staging.failure();
    expect(staging.posted).toEqual([]);
    // A hello from the production origin, then a failure, emit ready and the failure to the production origin only.
    const prod = run({ origins: codeShellOriginsFor('ezil.org') });
    prod.message(hello, { origin: PROD }); prod.failure();
    expect(prod.posted.map(p => p.origin)).toEqual([PROD, PROD]);
    expect(prod.posted[0]!.message).toEqual(ready);
    expect(prod.posted[1]!.message.type).toBe('ezil.code.failure');
    expect(prod.posted[1]!.message.failure).toEqual(record);
  });
  it('leaves HTML alone without a head or valid nonce, and an unknown zone injects nothing', () => {
    for (const bad of [html.replace('nonce="12345678-abcd"', ''), html.replace('12345678-abcd', 'bad'), html.replace('<head>', '')]) {
      expect(injectCodeDiagBridge(bad, [SHELL])).toBe(bad);
    }
    const noMeta = html.replace('<meta charset="utf-8">', '');
    expect(injectCodeDiagBridge(noMeta, [SHELL])).toContain('<head>\n<script nonce="12345678-abcd" data-ezil-diag-bridge="1">');
    expect(injectCodeDiagBridge(html, codeShellOriginsFor('unknown.example'))).toBe(html);
  });
  it('cannot close its own script tag or send to a wildcard', () => {
    expect(codeDiagBridgeScript([SHELL])).not.toMatch(/<\/|<!--|["']\*["']/);
    expect(injectCodeDiagBridge(html, ['</script>'])).toBe(html);
  });
});
