import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import fixtures from '../../app/src/server/feedback/app-failures.fixtures.json';
import { codeShellOriginsFor, injectCodeFolderBridge } from './code-folder-bridge';
import { codeDiagBridgeScript, DIAG_BRIDGE_MARKER, injectCodeDiagBridge } from './code-diag-bridge';

const SHELL = 'https://os-staging.ezil.work';
const OTHER = 'https://other.ezil.work';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const hello = { type: 'ezil.code.diag.hello', v: 1, nonce: NONCE };
const record = fixtures.valid[0]!.failure;
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
  return { posted, listeners, message, raw, failure, window, advance: (ms: number) => { now += ms; } };
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
      b.message(); expect(b.posted).toHaveLength(2); // invalid hello did not flush or discard
    }
  });
  it('posts exactly once with the parent hello nonce and exact target origin; newer hello replaces both', () => {
    const b = run({ origins: [SHELL, OTHER] });
    b.message(); b.failure();
    expect(b.posted).toEqual([{ message: { type: 'ezil.code.failure', v: 1, nonce: NONCE, failure: record }, origin: SHELL }]);
    const nonce = 'BBBBBBBBBBBBBBBBBBBBBB';
    b.message({ ...hello, nonce }, { origin: OTHER }); b.failure();
    expect(b.posted[1]).toEqual({ message: { type: 'ezil.code.failure', v: 1, nonce, failure: record }, origin: OTHER });
  });
  it('queues before hello, dropping the oldest beyond ten; hello flushes only once in order', () => {
    const b = run();
    const records = Array.from({ length: 13 }, (_, i) => ({ ...record, attempt: i + 1 }));
    records.forEach(b.failure); expect(b.posted).toEqual([]);
    b.message(); expect(b.posted.map(p => p.message.failure)).toEqual(records.slice(3));
    b.message(); expect(b.posted).toHaveLength(10);
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
    expect(b.posted).toHaveLength(30); // only the first ten expired
    b.advance(30_000); b.failure(); expect(b.posted).toHaveLength(31);
  });
  it('checks the 2048-byte serialized envelope ceiling', () => {
    // Canonical field bounds currently keep valid records below 2048 bytes. Inject the encoder size to
    // exercise the envelope guard itself, independently of rejecting an overlong field at validation.
    for (const encodedSize of [2048, 2049]) {
      const b = run({ encodedSize }); b.message(); b.failure();
      expect(b.posted).toHaveLength(encodedSize === 2048 ? 1 : 0);
    }
    const b = run(); b.message(); b.failure({ ...record, modelKey: 'x'.repeat(3000) });
    expect(b.posted).toHaveLength(0);
  });
  it('swallows malformed JSON, getters and postMessage errors, and keeps listening', () => {
    const b = run(); b.message();
    for (const detail of ['{', '', 'null', '[]', '{}', 1, record]) b.raw(detail);
    expect(() => b.window.dispatchEvent({ type: 'ezil-app-failure', get detail() { throw new Error('bad'); } })).not.toThrow();
    expect(() => b.message({ ...hello, get nonce() { throw new Error('bad'); } })).not.toThrow();
    expect(b.posted).toEqual([]); b.failure(); expect(b.posted).toHaveLength(1);
    const broken = run({ throws: true }); broken.failure();
    expect(() => broken.message()).not.toThrow(); expect(() => broken.failure()).not.toThrow();
  });
});

describe('canonical app-failure fixtures', () => {
  for (const entry of fixtures.valid) it(`posts unchanged: ${entry.name}`, () => {
    const b = run(); b.message(); b.failure(entry.failure);
    expect(b.posted.map(p => p.message.failure)).toEqual([entry.failure]);
  });
  for (const entry of fixtures.rejected) it(`never queues or posts: ${entry.name}`, () => {
    const b = run(); b.failure(entry.failure); b.message(); b.failure(entry.failure);
    expect(b.posted).toEqual([]);
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
    invalid.push({ ...cancellation, outcome: 'failed' }, { ...cancellation, code: 'unexpected_error' });
    for (const failure of invalid) {
      const b = run(); b.message(); b.failure(failure); expect(b.posted).toEqual([]);
    }
  });
  it('accepts all numeric boundaries and maximum model-key length', () => {
    for (const values of [{ attempt: 1, durationMs: 0, httpStatus: 100 }, { attempt: 64, durationMs: 3600000, httpStatus: 599 }]) {
      const b = run(); b.message(); const failure = { ...record, ...values, modelKey: 'm'.repeat(64) };
      b.failure(failure); expect(b.posted[0]!.message.failure).toEqual(failure);
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
  it('production has no origins and injects nothing; missing head/nonce also leaves HTML alone', () => {
    for (const zone of [undefined, 'ezil.org']) expect(injectCodeDiagBridge(html, codeShellOriginsFor(zone))).toBe(html);
    for (const bad of [html.replace('nonce="12345678-abcd"', ''), html.replace('12345678-abcd', 'bad'), html.replace('<head>', '')]) {
      expect(injectCodeDiagBridge(bad, [SHELL])).toBe(bad);
    }
    const noMeta = html.replace('<meta charset="utf-8">', '');
    expect(injectCodeDiagBridge(noMeta, [SHELL])).toContain('<head>\n<script nonce="12345678-abcd" data-ezil-diag-bridge="1">');
  });
  it('cannot close its own script tag or send to a wildcard', () => {
    expect(codeDiagBridgeScript([SHELL])).not.toMatch(/<\/|<!--|["']\*["']/);
    expect(injectCodeDiagBridge(html, ['</script>'])).toBe(html);
  });
});
