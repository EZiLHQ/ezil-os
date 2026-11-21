import { creditsUnconfirmed, parsePushedAccessToken, readLimited, type CreditsRelay } from './ai-proxy';

const BALANCE_URL = 'https://ai-staging.ezil.work/v1/me/balance';
const MAX_GATEWAY_BALANCE_BYTES = 64 * 1024;

type AccountCredential = { boot: string; token: string; creditsRelay: CreditsRelay };
type AccountRead = {
  owner: string;
  sandboxId: string;
  current: () => Promise<AccountCredential | null>;
  fetch: typeof fetch;
  signal: AbortSignal;
};

function microcredits(value: unknown): string | null {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && /^(?:0|[1-9]\d{0,99})$/.test(text) ? text : null;
}

/** Read the same owner into an exact, bounded machine response without refreshing or exporting their credential. */
export async function readAiAccountBalance(input: AccountRead) {
  try {
    const before = await input.current();
    if (!before || !parsePushedAccessToken(before.token, input.sandboxId, Date.now(), input.owner).ok) return null;
    const response = await input.fetch(BALANCE_URL, {
      method: 'GET',
      headers: { authorization: 'Bearer ' + before.token, accept: 'application/json', 'cache-control': 'no-store' },
      redirect: 'error',
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(3_000)]),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = await readLimited(response.body, MAX_GATEWAY_BALANCE_BYTES);
    if (!bytes) return null;
    const balance = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
    if (typeof balance !== 'object' || balance === null || Array.isArray(balance)) return null;
    // The current Gateway accounting projection preserves integer precision.
    // Legacy Gateways return top-level numbers, accepted only in the safe range.
    const amounts = balance.accounting?.contract === 'ezil.gateway.balance.v1' ? balance.accounting : balance;
    const balanceMicro = microcredits(amounts.available_micro);
    const heldMicro = microcredits(amounts.held_micro);
    if (balanceMicro === null || heldMicro === null) return null;

    const after = await input.current();
    if (!after || after.boot !== before.boot || after.token !== before.token
        || !parsePushedAccessToken(after.token, input.sandboxId, Date.now(), input.owner).ok) return null;
    if (balanceMicro === '0' && await creditsUnconfirmed({ creditsRelay: async () => after.creditsRelay })) return null;
    return { balanceMicro, heldMicro };
  } catch {
    return null;
  }
}
