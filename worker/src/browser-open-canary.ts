import { hmacSha256Hex, resolveNekoDerivationSecret } from './hmac';

export const BROWSER_CANARY_WORKER_ORIGIN = 'https://api-desktop.ezil.org';
export const BROWSER_CANARY_READY_BODY = '{"capability":"browser_open_url"}';
export const BROWSER_CANARY_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

interface BrowserCanaryEnv {
  SANDBOX_MCP_BROWSER_PROD_CANARY?: string;
  EZIL_BROWSER_PROD_CANARY_USER_ID?: string;
  EZIL_BROWSER_PROD_CANARY_COMPUTER_ID?: string;
  EZIL_BROWSER_PROD_CANARY_TEST_ORIGIN?: string;
  SANDBOX_HMAC_SECRET?: string;
  CLOUDFLARE_GUACAMOLE_HMAC_SECRET?: string;
}

export function canaryBrowserDestination(raw: string, origin: string): boolean {
  if (!/^https:\/\//i.test(raw) || raw.length > 2048 || /[\s\u0000-\u0020\u007f\\]/u.test(raw)) return false;
  try {
    const url = new URL(raw);
    // Only dotted DNS destinations. Exclude every IP literal and loopback name.
    return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password
      && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(url.hostname) && /[a-z]/i.test(url.hostname)
      && !url.hostname.endsWith('.localhost') && url.href.length <= 2048;
  } catch {
    return false;
  }
}

export function browserCanaryPin(env: BrowserCanaryEnv) {
  const userId = env.EZIL_BROWSER_PROD_CANARY_USER_ID ?? '';
  const computerId = env.EZIL_BROWSER_PROD_CANARY_COMPUTER_ID ?? '';
  const origin = env.EZIL_BROWSER_PROD_CANARY_TEST_ORIGIN ?? '';
  if (env.SANDBOX_MCP_BROWSER_PROD_CANARY !== 'on' || !BROWSER_CANARY_UUID.test(userId) || !BROWSER_CANARY_UUID.test(computerId)
    || !canaryBrowserDestination(origin, origin)) return undefined;
  return { userId, computerId, origin };
}

export async function productionBrowserBootToken(env: BrowserCanaryEnv, sandboxId: string, nonce: string): Promise<string | null> {
  const secret = resolveNekoDerivationSecret(env);
  if (!secret) return null;
  const key = await hmacSha256Hex(secret, ['EZIL-PROD-WORKER-BROWSER/1', sandboxId, nonce].join('\n'));
  const bytes = (key.match(/../g) ?? []).map(byte => parseInt(byte, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
