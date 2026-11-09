import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { injectCodeFolderBridge } from './code-folder-bridge';
import { injectCodeDiagBridge } from './code-diag-bridge';
import { BILLING_BRIDGE_MARKER, codeBillingBridgeScript, injectCodeBillingBridge } from './code-billing-bridge';

const SHELL = 'https://os-staging.ezil.work';
const OTHER = 'https://other.ezil.work';
const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA';
const UUID = '6f1d3a52-9b0e-4c1d-8a7b-2e5f4d3c2b1a';
const hello = { type: 'ezil.code.billing.hello', v: 1, nonce: NONCE };
type Posted = { message: Record<string, unknown>; origin: string };

function run({ framed = true, origins = [SHELL], throws = false }: { framed?: boolean; origins?: string[]; throws?: boolean } = {}) {
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
  const context = { window, Date: { now: () => now } };
  const globals = Object.keys(context);
  runInNewContext(codeBillingBridgeScript(origins), context);
  expect(Object.keys(context)).toEqual(globals);
  const message = (data: unknown = hello, over: Record<string, unknown> = {}) =>
    window.dispatchEvent({ type: 'message', source: parent, origin: SHELL, data, ...over });
  // As the patched renderer dispatches it: a cancelable event whose detail is the closed record as JSON.
  const ask = (detail: unknown) => {
    const event = { type: 'ezil-billing-intent', detail: typeof detail === 'string' ? detail : JSON.stringify(detail), defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } };
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const intents = () => posted.filter(p => p.message.type === 'ezil.code.billing.intent');
  return { posted, intents, listeners, message, ask, advance: (ms: number) => { now += ms; } };
}

describe('billing bridge: Code asks the EZiL OS shell that frames it for its billing dialog', () => {
  it('is inert outside a frame or without pinned origins', () => {
    for (const options of [{ framed: false }, { origins: [] }]) {
      const b = run(options); b.message();
      expect(b.ask({ reason: 'credits_exhausted' })).toBe(false);
      expect(b.listeners).toEqual({}); expect(b.posted).toEqual([]);
    }
  });

  it('answers only a well-formed hello from the parent at a pinned origin, with one ready', () => {
    const cases: Array<[unknown, Record<string, unknown>?]> = [
      [hello, { source: {} }], [hello, { origin: OTHER }], [hello, { origin: 'null' }], [{ ...hello, extra: true }],
      [{ type: hello.type, nonce: NONCE }], [{ ...hello, v: 2 }], [{ ...hello, type: 'ezil.code.diag.hello' }], [null], ['hello'], [[]],
      ...['', 'a'.repeat(21), 'a'.repeat(23), `${NONCE}\n`, 'a'.repeat(21) + '+', 22].map(nonce => [{ ...hello, nonce }] as [unknown]),
    ];
    for (const [data, over] of cases) {
      const b = run(); b.message(data, over);
      expect(b.posted).toEqual([]);
      expect(b.ask({ reason: 'credits_exhausted' })).toBe(false);
    }
    const b = run();
    b.message();
    expect(b.posted).toEqual([{ message: { type: 'ezil.code.billing.ready', v: 1, nonce: NONCE }, origin: SHELL }]);
  });

  it('forwards a closed record to that origin under its nonce and cancels the event; never before the handshake', () => {
    const b = run();
    expect(b.ask({ reason: 'credits_exhausted', requestId: UUID })).toBe(false); // not queued
    b.message();
    expect(b.ask({ reason: 'credits_exhausted', requestId: UUID })).toBe(true);
    expect(b.ask({ reason: 'model_locked', model: 'gemini-3.1-pro' })).toBe(true);
    expect(b.intents()).toEqual([
      { message: { type: 'ezil.code.billing.intent', v: 1, nonce: NONCE, intent: { reason: 'credits_exhausted', requestId: UUID } }, origin: SHELL },
      { message: { type: 'ezil.code.billing.intent', v: 1, nonce: NONCE, intent: { reason: 'model_locked', model: 'gemini-3.1-pro' } }, origin: SHELL },
    ]);
  });

  it('drops anything but the two reasons, a UUID and a catalog alias, and never cancels what it dropped', () => {
    const b = run(); b.message();
    for (const bad of [{ reason: 'topup' }, { reason: 'credits_exhausted', extra: 1 }, { reason: 'credits_exhausted', requestId: 'NOT-A-UUID' },
      { reason: 'model_locked', model: 'Bad Alias' }, { reason: 'model_locked', model: 7 }, [], null, 'credits_exhausted', '{', `{"reason":"credits_exhausted","x":"${'a'.repeat(512)}"}`]) {
      expect(b.ask(bad)).toBe(false);
    }
    expect(b.intents()).toEqual([]);
  });

  it('caps posts at ten a minute, ready included, and a failed post is not a cancel', () => {
    const b = run(); b.message();
    const taken = Array.from({ length: 12 }, () => b.ask({ reason: 'credits_exhausted' }));
    expect(taken.filter(Boolean)).toHaveLength(9);
    b.advance(60_001);
    expect(b.ask({ reason: 'credits_exhausted' })).toBe(true);
    const down = run({ throws: true }); down.message();
    expect(down.ask({ reason: 'credits_exhausted' })).toBe(false);
  });
});

describe('injectCodeBillingBridge', () => {
  const page = '<!DOCTYPE html><html><head><meta charset="utf-8"><script nonce="abcdefgh12">boot()</script></head><body></body></html>';
  it('adds one script under the page nonce after the charset, once, beside the other two bridges', () => {
    const all = injectCodeBillingBridge(injectCodeDiagBridge(injectCodeFolderBridge(page, [SHELL]), [SHELL]), [SHELL]);
    expect(all.split(BILLING_BRIDGE_MARKER).length - 1).toBe(1);
    expect(all).toContain(`<meta charset="utf-8">\n<script nonce="abcdefgh12" ${BILLING_BRIDGE_MARKER}="1">`);
    expect(all).toContain('data-ezil-diag-bridge');
    expect(injectCodeBillingBridge(all, [SHELL])).toBe(all);
  });
  it('leaves the page alone without origins, a valid nonce or a head', () => {
    for (const [html, origins] of [[page, []], [page.replace('nonce="abcdefgh12"', 'nonce="x"'), [SHELL]], ['<html><body></body></html>', [SHELL]]] as const) {
      expect(injectCodeBillingBridge(html, origins)).toBe(html);
    }
  });
});
