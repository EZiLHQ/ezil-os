import { describe, expect, it } from 'bun:test';
import { readRelayState, relayOperation, RelayFailure, relayFailureResult, remainingRelayBudget } from './relay-refresh';
const runtimeId = 'a'.repeat(32);
const current = { runtimeId, expiresAt: Date.now() + 300000 };
function fixture(options: { loginFails?: boolean; unavailable?: boolean; postStatus?: number; wrongRuntime?: boolean } = {}) {
  const requests: { path: string; init: RequestInit }[] = [];
  return { requests, container: { async containerFetch(url: string, init: RequestInit = {}) {
    const path = new URL(url).pathname;
    requests.push({ path, init });
    if (path === '/api/logout') return new Response(null,{status:204});
    if (path === '/api/login') return Response.json({ token: 'private-test-session' }, { status: options.loginFails ? 401 : 200 });
    if (init.method === 'GET') return Response.json(current, { status: options.unavailable ? 503 : 200 });
    const body = JSON.parse(String(init.body));
    return Response.json({ runtimeId: options.wrongRuntime ? 'b'.repeat(32) : runtimeId, expiresAt: body.expiresAt }, { status: options.postStatus ?? 200 });
  } } };
}
const mint = async () => ({ servers: [{ urls: ['turn:relay.example:3478'], username: 'ephemeral', credential: 'private-test-credential' }], expiresAt: current.expiresAt + 300000 });
describe('relay refresh failure handling', () => {
  it('checkpoint queueing shares the forwarding budget and fences expired operations', () => {
    expect(remainingRelayBudget(1000, 6500)).toBe(21500);
    expect(remainingRelayBudget(1000, 1000)).toBe(24000);
    expect(() => remainingRelayBudget(1000, 28000)).toThrow('relay_busy');
  });
  it('serializes typed failures before RPC without exporting arbitrary exception text', () => {
    const result = JSON.parse(JSON.stringify(relayFailureResult(new RelayFailure('relay_busy', 409))));
    expect(result).toEqual({ok:false,error:'relay_busy',status:409});
    expect(relayFailureResult(new Error('private credentials'))).toEqual({ok:false,error:'relay_refresh_failed',status:502});
  });
  it('metadata rejects missing runtime identity and invalid expiry', () => {
    for (const value of [null, {}, { runtimeId, expiresAt: 0 }, { runtimeId: 'invalid', expiresAt: 1 }]) expect(() => readRelayState(value)).toThrow('relay_metadata_invalid');
  });
  it('requires backend authentication and does not mint on login failure', async () => {
    const f = fixture({ loginFails: true }); let minted = false;
    await expect(relayOperation(f.container, 'admin-test-only', { runtimeId, mint: async () => { minted = true; return mint(); } })).rejects.toThrow('relay_login_failed');
    expect(minted).toBe(false); expect(f.requests).toHaveLength(1);
  });
  it('unavailable relay fails explicitly and cannot publish refresh success', async () => {
    const f = fixture({ unavailable: true });
    await expect(relayOperation(f.container, 'admin-test-only', { runtimeId, mint })).rejects.toThrow('relay_unavailable');
    expect(f.requests.some(r => r.path === '/api/relay' && r.init.method === 'POST')).toBe(false);
  });
  it('stale runtime is fenced before credential minting or peer mutation', async () => {
    const f = fixture(); let minted = false;
    await expect(relayOperation(f.container, 'admin-test-only', { runtimeId: 'b'.repeat(32), mint: async () => { minted = true; return mint(); } })).rejects.toThrow('relay_runtime_changed');
    expect(minted).toBe(false); expect(f.requests).toHaveLength(3);
  });
  it('TURN credential mint failure preserves the backend configuration', async () => {
    const f = fixture();
    await expect(relayOperation(f.container, 'admin-test-only', { runtimeId, mint: async () => { throw new Error('turn_unavailable'); } })).rejects.toThrow('turn_unavailable');
    expect(f.requests).toHaveLength(3);
  });
  it('rejects backend failed refresh, negotiation busy, and changed runtime', async () => {
    for (const [status, code] of [[400, 'relay_configuration_rejected'], [503, 'relay_refresh_failed'], [422, 'relay_negotiation_busy'], [409, 'relay_runtime_changed']] as const) {
      const f = fixture({ postStatus: status });
      await expect(relayOperation(f.container, 'admin-test-only', { runtimeId, mint })).rejects.toThrow(code);
    }
    const f = fixture({ wrongRuntime: true });
    await expect(relayOperation(f.container, 'admin-test-only', { runtimeId, mint })).rejects.toThrow('relay_refresh_unconfirmed');
  });
  it('applies frontend/backend ICE and confirms expiry without returning credentials', async () => {
    const f = fixture(); const applied = await relayOperation(f.container, 'admin-test-only', { runtimeId, mint });
    expect(applied).toEqual({ runtimeId, expiresAt: current.expiresAt + 300000 });
    const body = JSON.parse(String(f.requests.find(r=>r.path==='/api/relay' && r.init.method==='POST')?.init.body));
    expect(body.frontend).toHaveLength(1); expect(body.backend).toHaveLength(1);
    expect(Object.keys(applied).sort()).toEqual(['expiresAt', 'runtimeId']);
  });
  it('cancels the actual fetch and finishes logout before releasing a timed-out operation', async () => {
    const events: string[] = [];
    const container = { async containerFetch(url: string, init: RequestInit = {}) {
      const path = new URL(url).pathname;
      if (path === '/api/login') return Response.json({ token: 'test-session' });
      if (path === '/api/logout') { events.push('logout'); return new Response(null, { status: 204 }); }
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => { events.push('cancelled'); reject(init.signal!.reason); }, { once: true });
      });
    } };
    await expect(relayOperation(container, 'test-admin', { budgetMs: 10 })).rejects.toThrow('relay_timeout');
    expect(events).toEqual(['cancelled', 'logout']);
  });
  it('cannot report success when an administrative session failed to close', async () => {
    const f = fixture();
    const fetch = f.container.containerFetch;
    f.container.containerFetch = async (url, init) => url.endsWith('/logout') ? new Response(null, { status: 500 }) : fetch(url, init);
    await expect(relayOperation(f.container, 'test-admin', {})).rejects.toThrow('relay_logout_failed');
  });
});
