import { buildNekoIceEnv, type IceServerEntry } from './desktop-mode';

export interface RelayState { runtimeId: string; expiresAt: number }
export type RelayResult = ({ ok: true } & RelayState) | { ok: false; error: string; status: number };
// Keep queue time and TCP work within the existing 30-second forwarding budget.
export const RELAY_OPERATION_DEADLINE_MS = 27_000;
export function remainingRelayBudget(requestedAt: number, now = Date.now()): number {
  const remaining = RELAY_OPERATION_DEADLINE_MS - (now - requestedAt);
  if (remaining <= 0) throw new RelayFailure('relay_busy', 409);
  return Math.min(24_000, remaining);
}
// Custom Error subclasses lose their prototype across Durable Object RPC.
// Serialize failures inside the object, while their type is still available.
export function relayFailureResult(error: unknown): Extract<RelayResult, { ok: false }> {
  return error instanceof RelayFailure
    ? { ok: false, error: error.code, status: error.status }
    : { ok: false, error: 'relay_refresh_failed', status: 502 };
}
interface RelayContainer {
  containerFetch(url: string, init?: RequestInit, port?: number): Promise<Response>;
}
export class RelayFailure extends Error {
  constructor(public readonly code: string, public readonly status = 502) { super(code); }
}
export function readRelayState(raw: unknown): RelayState {
  const value = raw as Partial<RelayState> | null;
  if (!value || typeof value.runtimeId !== 'string' || !/^[a-f0-9]{32}$/.test(value.runtimeId)
      || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) {
    throw new RelayFailure('relay_metadata_invalid');
  }
  return { runtimeId: value.runtimeId, expiresAt: value.expiresAt };
}

/** Run inside the DO using its local TCP fetch, so cancellation never crosses RPC. */
export async function relayOperation(container: RelayContainer, admin: string, params: {
  runtimeId?: string; mint?: (signal: AbortSignal) => Promise<{ servers: IceServerEntry[]; expiresAt: number }>;
  budgetMs?: number;
}): Promise<RelayState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RelayFailure('relay_timeout', 504)), params.budgetMs ?? 24_000);
  const request = async (path: string, init: RequestInit): Promise<Response> => {
    controller.signal.throwIfAborted();
    return container.containerFetch(`http://127.0.0.1:8181${path}`, { ...init, signal: controller.signal }, 8181);
  };
  let token: string | undefined;
  let failed = false;
  try {
  const login = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'ezil-relay-refresh', password: admin }) });
  if (!login.ok) throw new RelayFailure('relay_login_failed');
  const loginData = await login.json() as { token?: unknown };
  if (typeof loginData.token !== 'string' || !loginData.token) throw new RelayFailure('relay_login_failed');
  token = loginData.token;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const response = await request('/api/relay', { method: 'GET', headers });
  if (!response.ok) throw new RelayFailure('relay_unavailable');
  const current = readRelayState(await response.json());
  if (!params.mint) return current;
  if (params.runtimeId !== current.runtimeId) throw new RelayFailure('relay_runtime_changed', 409);
  const minted = await params.mint(controller.signal);
  const configuration = buildNekoIceEnv(minted.servers);
  if (!configuration) throw new RelayFailure('turn_unavailable');
  const refreshed = await request('/api/relay', { method: 'POST', headers, body: JSON.stringify({
    runtimeId: current.runtimeId, expiresAt: minted.expiresAt,
    frontend: JSON.parse(configuration.NEKO_WEBRTC_ICESERVERS_FRONTEND!),
    backend: JSON.parse(configuration.NEKO_WEBRTC_ICESERVERS_BACKEND!),
  }) });
  if (!refreshed.ok) throw new RelayFailure(refreshed.status === 400 ? 'relay_configuration_rejected' : refreshed.status === 409 ? 'relay_runtime_changed' : refreshed.status === 422 ? 'relay_negotiation_busy' : 'relay_refresh_failed', [409,422].includes(refreshed.status) ? 409 : 502);
  const applied = readRelayState(await refreshed.json());
  if (applied.runtimeId !== current.runtimeId || applied.expiresAt < minted.expiresAt) throw new RelayFailure('relay_refresh_unconfirmed');
  return applied;
  } catch (error) {
    failed = true;
    if (controller.signal.aborted) throw new RelayFailure('relay_timeout', 504);
    throw error;
  } finally {
    clearTimeout(timer);
    // Await cancellation and cleanup before releasing the runtime lock. One
    // operation budget plus bounded cleanup fits the forwarding deadline.
    if (token) {
      try {
        const logout = await container.containerFetch('http://127.0.0.1:8181/api/logout', {
          method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(2_000),
        }, 8181);
        if (!logout.ok) throw new RelayFailure('relay_logout_failed');
        await logout.arrayBuffer();
      } catch {
        if (!failed) throw new RelayFailure('relay_logout_failed');
      }
    }
  }
}
