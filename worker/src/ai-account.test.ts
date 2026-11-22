import { describe, expect, it, mock } from 'bun:test';

import { readAiAccountBalance } from './ai-account';

const owner = 'abcdef01-2345-6789-abcd-ef0123456789';
const samePrefix = 'abcdef01-2345-6789-aaaa-aaaaaaaaaaaa';
const sandboxId = 'guac-abcdef0123456789-fedcba9876543210';
const credential = (sub: string, expires = Date.now() / 1000 + 3600) => ({
  boot: 'fixture-boot',
  creditsRelay: 'none' as const,
  token: 'e30.' + Buffer.from(JSON.stringify({ sub, exp: expires, role: 'authenticated' })).toString('base64url') + '.fixture',
});
const current = async () => credential(owner);
const abort = () => new AbortController().signal;

describe('staging owner AI account balance', () => {
  it('forwards only fixed GET using the same stored owner token and exposes only the bounded amounts', async () => {
    const snapshot = credential(owner);
    const fetch = mock(async (_url: URL | Request | string, _init?: RequestInit) =>
      Response.json({ available_micro: '1234', held_micro: 11, account_public_id: 'fixture-private-id', grants: [{}] }));
    expect(await readAiAccountBalance({ owner, sandboxId, current: async () => snapshot, fetch: fetch as unknown as typeof globalThis.fetch, signal: abort() }))
      .toEqual({ balanceMicro: '1234', heldMicro: '11' });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://ai-staging.ezil.work/v1/me/balance');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { authorization: 'Bearer ' + snapshot.token } });
    expect(init?.body).toBeUndefined();
  });

  it('refuses expired, missing or wrong actual owner tokens even if truncated sandbox prefixes match', async () => {
    const fetch = mock(async () => Response.json({ available_micro: '0', held_micro: '0' }));
    for (const read of [async () => null, async () => credential(samePrefix), async () => credential(owner, 0)]) {
      expect(await readAiAccountBalance({ owner, sandboxId, current: read, fetch: fetch as unknown as typeof globalThis.fetch, signal: abort() })).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves exact microcredits from the Gateway accounting projection', async () => {
    const rounded = { available_micro: 9_007_199_254_740_992, held_micro: 0 };
    const exact = { ...rounded, accounting: {
      contract: 'ezil.gateway.balance.v1', available_micro: '9007199254740993', held_micro: '0',
    } };
    const read = (body: typeof rounded) => readAiAccountBalance({
      owner, sandboxId, current, fetch: (async () => Response.json(body)) as typeof globalThis.fetch, signal: abort(),
    });
    expect(await read(exact)).toEqual({ balanceMicro: '9007199254740993', heldMicro: '0' });
    expect(await read(rounded)).toBeNull();
  });

  it('withholds the zero wallet during unconfirmed delivery and preserves a verified held amount', async () => {
    const fetch = async () => Response.json({ available_micro: '0', held_micro: '2' });
    for (const creditsRelay of ['pending', 'unknown'] as const) {
      const current = async () => ({ ...credential(owner), creditsRelay });
      expect(await readAiAccountBalance({ owner, sandboxId, current, fetch: fetch as typeof globalThis.fetch, signal: abort() }))
        .toBeNull();
    }
    expect(await readAiAccountBalance({ owner, sandboxId, current, fetch: fetch as typeof globalThis.fetch, signal: abort() }))
      .toEqual({ balanceMicro: '0', heldMicro: '2' });
  });

  it('rejects a Gateway redirect without a second credential-bearing request', async () => {
    const fetch = mock(async (_url: URL | Request | string, _init?: RequestInit) =>
      new Response(null, { status: 302, headers: { location: 'https://redirect.invalid' } }));
    const snapshot = credential(owner);
    const result = await readAiAccountBalance({ owner, sandboxId, current: async () => snapshot,
      fetch: fetch as unknown as typeof globalThis.fetch, signal: abort() });
    expect(result).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('drops a read on credential or boot replacement, invalid amounts, oversized or rejected responses', async () => {
    const before = credential(owner);
    const after = { ...before, boot: 'replacement' };
    let called = false;
    const success = async () => Response.json({ available_micro: '0', held_micro: '0' });
    const rotating = async () => { const result = called ? after : before; called = true; return result; };
    expect(await readAiAccountBalance({ owner, sandboxId, current: rotating, fetch: success as typeof globalThis.fetch, signal: abort() })).toBeNull();
    for (const fetch of [
      async () => Response.json({ available_micro: -1, held_micro: '0' }),
      async () => Response.json({ available_micro: '0', held_micro: '0', excess: 'a'.repeat(65536) }),
      async () => new Response(null, { status: 401 }),
    ]) expect(await readAiAccountBalance({ owner, sandboxId, current, fetch: fetch as typeof globalThis.fetch, signal: abort() })).toBeNull();
  });
});
