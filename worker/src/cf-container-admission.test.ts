import { describe, expect, it, mock, spyOn } from 'bun:test';
import { cfAdmissionRunningOnly, CF_ADMISSION_ERROR, cfAdmissionResponse } from './cf-container-admission';
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {} }));
const { Sandbox } = await import('./index');

// Real @cloudflare/sandbox methods/client and @cloudflare/containers start logic; only native runtime I/O is fake.
function fixture(flag: string | undefined = '1', running: unknown = false) {
  const values = new Map<string, unknown>();
  const calls = { starts: 0, fetches: 0, stops: 0 };
  let physical = running;
  let stopDuringStateRead = false;
  let stopOnFetch = false;
  const native = {
    get running() { return physical; },
    start() { calls.starts++; physical = true; },
    monitor: () => new Promise<void>(() => {}),
    signal() { calls.stops++; physical = false; },
    getTcpPort: () => ({ fetch: async () => {
      calls.fetches++;
      if (physical !== true) throw new Error('container is not running');
      if (stopOnFetch) physical = false;
      const res = new Response(null, { headers: { 'x-admission-fixture': 'live' } }); Object.defineProperty(res, 'webSocket', { value: null }); return res;
    } }),
  };
  const storage = { get: async (key: string) => values.get(key), put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key), setAlarm: async () => {}, sync: async () => {},
    transaction: async (fn: (tx: unknown) => unknown) => fn(storage) };
  const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return logger; } };
  const obj = Object.create(Sandbox.prototype) as any;
  Object.assign(obj, { env: { CF_CONTAINER_ADMISSION_PAUSED: flag, SANDBOX_AI_PROXY: 'off' },
    ctx: { container: native, storage, id: { toString: () => 'admission-fixture' }, blockConcurrencyWhile: async (fn: () => unknown) => fn(), waitUntil() {} },
    container: native, defaultPort: 3000, sleepAfter: '10m', enableInternet: true, envVars: {},
    logger, transport: 'http', containerGeneration: 0, defaultSession: null, defaultSessionInit: null,
    containerTimeouts: { instanceGetTimeoutMS: 5000, portReadyTimeoutMS: 10000, waitIntervalMS: 100 },
    inflightRequests: 0, applyOutboundInterceptionPromise: Promise.resolve(),
    state: { getState: async () => { if (stopDuringStateRead) physical = false; return { status: physical === true ? 'healthy' : 'stopped' }; },
      setRunning: async () => {}, setHealthy: async () => {}, setStopped: async () => {} },
    currentRuntime: { clear: async () => {} },
    syncPendingStoppedEvents: async () => {},
  });
  obj.client = obj.createSandboxClient();
  return { obj, values, calls, native, stopDuringStateRead: () => { stopDuringStateRead = true; }, physical: () => physical, stopOnFetch: () => { stopOnFetch = true; } };
}

describe('default-off CF container start admission', () => {
  it('only exact1 enables the pause; disabled does not even inspect physical state', () => {
    for (const value of [undefined, '0', 'off', 'true', '']) expect(cfAdmissionRunningOnly(value, () => { throw new Error('must not inspect'); })).toBe(false);
    for (const state of [false, undefined, null, 'running']) expect(() => cfAdmissionRunningOnly('1', () => state)).toThrow(CF_ADMISSION_ERROR);
    expect(() => cfAdmissionRunningOnly('1', () => { throw new Error('unknown'); })).toThrow(CF_ADMISSION_ERROR);
    expect(cfAdmissionRunningOnly('1', () => true)).toBe(true);
  });

  for (const operation of ['start', 'startAndWaitForPorts', 'containerFetch', 'exec', 'startProcess', 'fetch'] as const) {
    it(`blocks stopped-container ${operation} through the actual SDK before any native start`, async () => {
      const f = fixture();
      const started = Date.now();
      const work = operation === 'containerFetch' ? f.obj.containerFetch('http://localhost:3000/health', {}, 3000)
        : operation === 'exec' ? f.obj.exec('true') : operation === 'startProcess' ? f.obj.startProcess('true')
        : operation === 'fetch' ? f.obj.fetch(new Request('http://localhost/health')) : f.obj[operation]();
      await expect(work).rejects.toThrow(CF_ADMISSION_ERROR);
      expect(f.calls.starts).toBe(0); expect(f.calls.fetches).toBe(0);
      expect(Date.now() - started).toBeLessThan(500);
    });
  }

  for (const transport of ['http', 'websocket', 'rpc']) it(`blocks ${transport} SDK implicit bootstrap without a native start or long retry`, async () => {
    const f = fixture(); f.obj.transport = transport; f.obj.client = f.obj.createClientForTransport(transport);
    const start = Date.now();
    await expect(f.obj.exec('true')).rejects.toThrow(CF_ADMISSION_ERROR);
    expect(f.calls.starts).toBe(0); expect(f.calls.fetches).toBe(0);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('default-off delegates to the unchanged SDK start even if native status is unknown', async () => {
    const f = fixture(); delete f.obj.env.CF_CONTAINER_ADMISSION_PAUSED;
    const base = Object.getPrototypeOf(Sandbox.prototype);
    const start = spyOn(base, 'start').mockImplementation(async () => {});
    try { await f.obj.start(); expect(start).toHaveBeenCalledTimes(1); }
    finally { start.mockRestore(); }
  });

  it('never re-enters SDK provisioning if a live container stops after the admission check', async () => {
    const f = fixture('1', true); f.stopDuringStateRead();
    await expect(f.obj.containerFetch('http://localhost:3000/health', {}, 3000)).rejects.toThrow(CF_ADMISSION_ERROR);
    expect(f.calls.starts).toBe(0); expect(f.calls.fetches).toBe(0);
  });

  it('keeps live traffic and explicit Stop available; paused start hooks do not execute SDK start callbacks', async () => {
    const f = fixture('1', true);
    f.obj.onStart = () => { throw new Error('paused must not enter SDK start'); };
    await f.obj.start(); await f.obj.startAndWaitForPorts();
    const res = await f.obj.containerFetch('http://localhost:3000/health', {}, 3000);
    expect(res.status).toBe(200); expect(res.headers.get('x-admission-fixture')).toBe('live');
    expect(f.calls.fetches).toBe(1); expect(f.calls.starts).toBe(0);
    await f.obj.stop(); expect(f.calls.stops).toBe(1); expect(f.physical()).toBe(false);
  });

  it('preserves a successful live response if the container exits after finishing the request', async () => {
    const f = fixture('1', true); f.stopOnFetch();
    const res = await f.obj.containerFetch('http://localhost:3000/health', {}, 3000);
    expect(res.status).toBe(200); expect(res.headers.get('x-admission-fixture')).toBe('live');
    expect(f.physical()).toBe(false); expect(f.calls.starts).toBe(0);
  });

  it('leaves signed credential, pending status and activity metadata readable without a container', async () => {
    const f = fixture('1', undefined); const now = Date.now();
    await f.obj.putAiCredential({ token: 'fixture-only', expiresAt: now + 3600000 }, now, ['gemini-3.8-flash'], null);
    expect(await f.obj.getAiCredential()).toBe('fixture-only');
    expect(await f.obj.getAiCreditsRelay()).toBe('unknown');
    expect(await f.obj.getAiModelAccess()).toEqual({ known: true, includedModels: ['gemini-3.8-flash'] });
    await f.obj.recordActivity(0);
    expect(f.calls.starts).toBe(0); expect(f.calls.fetches).toBe(0);
  });

  it('returns a short noncached503 with a bounded retry hint', async () => {
    const res = cfAdmissionResponse();
    expect(res.status).toBe(503); expect(res.headers.get('retry-after')).toBe('10');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: false, error: CF_ADMISSION_ERROR,
      notice: 'Computers are being updated. Please retry shortly.', retryAfterSeconds: 10 });
  });
});
