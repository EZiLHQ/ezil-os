import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { codePreviewBridgeScript, injectCodePreviewBridge, PREVIEW_BRIDGE_MARKER } from './code-preview-bridge';
import { injectCodeBillingBridge } from './code-billing-bridge';

const vectors = JSON.parse(readFileSync(new URL('../../docs/contracts/code-preview-v1.vectors.json', import.meta.url), 'utf8'));
const SHELL = 'https://os.ezil.work', NONCE = 'AAAAAAAAAAAAAAAAAAAAAA', ID = 'BBBBBBBBBBBBBBBBBBBBBB';
const hello = { type: 'ezil.code.preview.hello', v: 1, nonce: NONCE };
function run({ origins = [SHELL], framed = true, throws = false } = {}) {
  let now = 0;
  const posted: any[] = [], replies: any[] = [], listeners: Record<string, Function[]> = {};
  const parent = { postMessage(message: any, origin: string) { if (throws) throw Error('gone'); posted.push({ message: structuredClone(message), origin }); } };
  const window: any = { parent, addEventListener(t: string, f: Function) { (listeners[t] ??= []).push(f); },
    dispatchEvent(ev: any) { for (const f of listeners[ev.type] ?? []) f(ev); } };
  if (!framed) window.parent = window;
  class CustomEvent { constructor(public type: string, public options: any) {} get detail() { return this.options.detail; } }
  const context = { window, URL, Date: { now: () => now }, CustomEvent };
  const globals = Object.keys(context);
  runInNewContext(codePreviewBridgeScript(origins), context);
  expect(Object.keys(context)).toEqual(globals);
  window.addEventListener('ezil-preview-mint-reply', (ev: any) => replies.push(JSON.parse(ev.detail)));
  const message = (data: any = hello, over: any = {}) => window.dispatchEvent({ type: 'message', data, source: parent, origin: SHELL, ...over });
  const ask = (record: any = { v: 1, id: ID }, cancelable = true) => {
    const event = { type: 'ezil-preview-mint', detail: typeof record === 'string' ? record : JSON.stringify(record), cancelable,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    window.dispatchEvent(event); return event.defaultPrevented;
  };
  const answer = (record: any, over: any = {}) => message({ type: 'ezil.code.preview.url', v: 1, nonce: NONCE, id: ID, ...record }, over);
  return { posted, replies, message, ask, answer, advance: (ms: number) => { now += ms; } };
}

describe('Code preview mint bridge', () => {
  it('is inert without a parent, origins or a handshake; only cancelable events are taken', () => {
    for (const options of [{ framed: false }, { origins: [] }]) {
      const b = run(options); b.message(); expect(b.ask()).toBe(false); expect(b.posted).toEqual([]);
    }
    const b = run(); expect(b.ask()).toBe(false); b.message(); expect(b.ask(undefined, false)).toBe(false);
    expect(b.ask()).toBe(true);
    expect(b.posted).toEqual([{ message: { type: 'ezil.code.preview.ready', v: 1, nonce: NONCE }, origin: SHELL },
      { message: { type: 'ezil.code.preview.mint', v: 1, nonce: NONCE, id: ID }, origin: SHELL }]);
  });
  it('refuses spoofed source/origin, malformed hello and wildcard origins', () => {
    for (const [data, over] of [[hello, { source: {} }], [hello, { origin: 'https://evil.test' }], [hello, { origin: 'null' }],
      [{ ...hello, v: 2 }, {}], [{ ...hello, nonce: NONCE + '\n' }, {}], [{ ...hello, extra: true }, {}], [[], {}]]) {
      const b = run(); b.message(data, over); expect(b.posted).toEqual([]); expect(b.ask()).toBe(false);
    }
    const b = run({ origins: ['*'] }); b.message(hello, { origin: '*' }); expect(b.posted).toEqual([]);
  });
  for (const [i, record] of vectors.mintReply.accept.entries()) it(`accepts mintReply vector ${i}`, () => {
    const b = run(); b.message(); b.ask(); b.answer(record);
    expect(b.replies).toEqual([{ v: 1, id: ID, ...record }]);
    expect(b.posted.every(p => p.origin !== '*')).toBe(true);
  });
  for (const [i, record] of vectors.mintReply.refuse.entries()) it(`refuses mintReply vector ${i}`, () => {
    const b = run(); b.message(); b.ask(); b.answer(record); expect(b.replies).toEqual([]);
  });
  it('drops unsolicited, duplicate, stale and spoofed answers; rebinds only to the latest hello', () => {
    const r = vectors.mintReply.accept[0], b = run(); b.message(); b.answer(r); expect(b.replies).toEqual([]);
    b.ask(); b.answer(r, { source: {} }); b.answer(r, { origin: 'https://evil.test' });
    b.answer({ ...r, nonce: 'CCCCCCCCCCCCCCCCCCCCCC' }); b.answer({ ...r, id: NONCE }); b.answer({ ...r, extra: true });
    expect(b.replies).toEqual([]); b.answer(r); b.answer(r); expect(b.replies).toHaveLength(1); expect(b.ask()).toBe(false);
    const stale = run(); stale.message(); stale.ask(); stale.message({ ...hello, nonce: ID }); stale.answer(r);
    expect(stale.replies).toEqual([]);
  });
  it('rejects invalid request records and all attachment vectors at this mint-only boundary', () => {
    const b = run(); b.message();
    for (const r of [null, [], '{', { v: 2, id: ID }, { v: 1, id: 'short' }, { v: 1, id: ID + '\n' }, { v: 1, id: ID, extra: 1 },
      ...vectors.attachment.accept, ...vectors.attachment.refuse]) expect(b.ask(r)).toBe(false);
  });
  it('accepts AWS app URLs and refuses wrong AWS ports, credentials, ports and malformed expiry', () => {
    const b = run(); b.message(); b.ask(); b.answer({ url: 'https://aws-3002-guac-u-c-aws.ezil.work/preview-bootstrap?token=t', expiresAt: 1795000000000 });
    expect(b.replies).toHaveLength(1);
    for (const url of ['https://aws-3000-guac-u-c-aws.ezil.work/', 'https://aws-9223-guac-u-c-aws.ezil.work/',
      'https://aws-8443-guac-u-c-aws.ezil.work/', 'https://u:p@3002-guac-u-c-app.ezil.org/', 'https://3002-guac-u-c-app.ezil.org:3002/',
      'https://3002-guac-u-c-app.ezil.org/\n']) {
      const b = run(); b.message(); b.ask(); b.answer({ url, expiresAt: 1 }); expect(b.replies).toEqual([]);
    }
    for (const expiresAt of [null, '1', -1, 0, 1.5, Infinity]) {
      const b = run(); b.message(); b.ask(); b.answer({ url: vectors.mintReply.accept[0].url, expiresAt }); expect(b.replies).toEqual([]);
    }
  });
  it('caps posts at ten per minute including ready; failed posts never cancel the event', () => {
    const b = run(); b.message(); let accepted = 0;
    for (let i = 0; i < 12; i++) if (b.ask({ v: 1, id: String(i).padStart(22, 'A') })) accepted++;
    expect(accepted).toBe(9); b.advance(60000); expect(b.ask()).toBe(true);
    const down = run({ throws: true }); down.message(); expect(down.ask()).toBe(false);
  });
});

describe('injectCodePreviewBridge', () => {
  const page = '<html><head><meta charset="utf-8"><script nonce="abcdefgh12">boot()</script></head></html>';
  it('inserts once after charset under the CSP nonce beside billing, without globals', () => {
    const result = injectCodePreviewBridge(injectCodeBillingBridge(page, [SHELL]), [SHELL]);
    expect(result.split(PREVIEW_BRIDGE_MARKER)).toHaveLength(2);
    expect(result).toContain(`<meta charset="utf-8">\n<script nonce="abcdefgh12" ${PREVIEW_BRIDGE_MARKER}="1">`);
    expect(injectCodePreviewBridge(result, [SHELL])).toBe(result); expect(result).toContain('data-ezil-billing-bridge');
  });
  it('refuses missing/invalid nonces, missing heads, empty origins and script-breaking origins', () => {
    for (const [html, origins] of [[page, []], [page.replace('abcdefgh12', 'x'), [SHELL]], [page.replace('<head>', '<body>'), [SHELL]],
      [page, ['https://evil.test/</script>']]] as const) expect(injectCodePreviewBridge(html, origins)).toBe(html);
  });
});
