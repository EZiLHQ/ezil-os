import { describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {} }));

const runtimeId = 'a'.repeat(32);
const pending = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const blocked = Symbol('blocked');
const within = <T>(promise: Promise<T>, ms = 1000) => Promise.race([promise, new Promise<typeof blocked>(resolve => setTimeout(() => resolve(blocked), ms))]);

async function fakeSandbox({ checkpoint, relayPost }: { checkpoint?: Promise<void>; relayPost?: Promise<void> } = {}) {
  const { Sandbox } = await import('./index');
  const paths: string[] = [];
  let expiresAt = 400000;
  const fake = Object.assign(Object.create(Sandbox.prototype), {
    // A checkpoint in flight holds both persistence locks, as the scheduled
    // flush cycle and a teardown's final checkpoint do.
    runtimeMutationTail: checkpoint ?? Promise.resolve(),
    workspacePersistenceTail: checkpoint ?? Promise.resolve(),
    relayTail: Promise.resolve(),
    runtimeTransitionsInFlight: 0,
    env: { SANDBOX_HMAC_SECRET: 'queue-test-only', SANDBOX_NEKO_TURN_KEY_ID: 'key-test-only', SANDBOX_NEKO_TURN_API_TOKEN: 'token-test-only' },
    ctx: {
      storage: { get: async () => undefined },
      container: { running: true, getTcpPort: () => ({ fetch: async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname; paths.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/api/login') return Response.json({ token: 'private-test-token' });
        if (path === '/api/logout') return new Response(null, { status: 204 });
        if (init?.method === 'POST') {
          await relayPost;
          expiresAt = JSON.parse(String(init.body)).expiresAt;
        }
        return Response.json({ runtimeId, expiresAt });
      } }) },
    },
  });
  return { fake, paths };
}

async function withTurn<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ iceServers: [{ urls: ['turn:relay.example:3478?transport=udp'], username: 'u', credential: 'private-test-credential' }] })) as unknown as typeof fetch;
  try { return await run(); } finally { globalThis.fetch = realFetch; }
}

describe('relay operations and checkpoint contention', () => {
  it('reads and renews relay credentials while a checkpoint longer than the relay budget is in flight', async () => {
    // Observed in staging: a 36 s system-layer checkpoint, past the 27 s relay
    // budget. Credential renewal must not wait on it at all.
    const checkpoint = pending();
    const { fake, paths } = await fakeSandbox({ checkpoint: checkpoint.promise });
    const read = await within(fake.relayRefresh('guac-queue-test'));
    expect(read).toEqual({ ok: true, runtimeId, expiresAt: 400000 });
    const renewed = await within(withTurn(() => fake.relayRefresh('guac-queue-test', runtimeId)));
    expect(renewed).not.toBe(blocked);
    expect((renewed as { ok: boolean }).ok).toBe(true);
    expect(paths).toContain('POST /api/relay');
    checkpoint.release();
  });

  it('a relay renewal during teardown fails closed and never reaches the runtime', async () => {
    const teardown = pending();
    const { fake, paths } = await fakeSandbox();
    let stopped = false;
    fake.terminateSandboxWithCheckpoint = async () => { await teardown.promise; stopped = true; return { ok: true, outcome: 'destroyed', terminated: true }; };
    const stopping = fake.terminateSandbox();
    await new Promise(resolve => setTimeout(resolve, 0));
    const refused = await withTurn(() => fake.relayRefresh('guac-queue-test', runtimeId));
    expect(JSON.parse(JSON.stringify(refused))).toEqual({ ok: false, error: 'relay_runtime_not_running', status: 409 });
    expect(paths).toEqual([]);
    teardown.release();
    await stopping;
    expect(stopped).toBe(true);
    expect(fake.runtimeTransitionsInFlight).toBe(0);
  });

  it('a teardown waits for an in-flight relay renewal before stopping the runtime', async () => {
    const post = pending();
    const { fake } = await fakeSandbox({ relayPost: post.promise });
    const order: string[] = [];
    fake.terminateSandboxWithCheckpoint = async () => { order.push('teardown'); return { ok: true, outcome: 'destroyed', terminated: true }; };
    const renewal = withTurn(() => fake.relayRefresh('guac-queue-test', runtimeId)).then(result => { order.push('renewed'); return result; });
    await new Promise(resolve => setTimeout(resolve, 10));
    const stopping = fake.terminateSandbox();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(order).toEqual([]);
    post.release();
    expect((await renewal).ok).toBe(true);
    await stopping;
    expect(order).toEqual(['renewed', 'teardown']);
  });

  it('relay operations still serialize, and one queued past its budget never touches the runtime', async () => {
    const realNow = Date.now;
    let time = 1000;
    const post = pending();
    const { fake, paths } = await fakeSandbox({ relayPost: post.promise });
    Date.now = () => time;
    try {
      const first = withTurn(() => fake.relayRefresh('guac-queue-test', runtimeId));
      const second = fake.relayRefresh('guac-queue-test');
      await new Promise(resolve => setTimeout(resolve, 10));
      const before = paths.length;
      time += 27000; post.release();
      await first;
      expect(JSON.parse(JSON.stringify(await second))).toEqual({ ok: false, error: 'relay_busy', status: 409 });
      expect(paths.length).toBe(before + 1); // only the first operation's logout
    } finally { Date.now = realNow; }
  });

  it('every runtime stop and restart path fences relay operations', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
    expect(source).toContain('await this.withRuntimeTransition(() => this.stop());');
    expect(source).toContain('return this.withRuntimeMutation(() => this.withRuntimeTransition(() => this.withWorkspacePersistence(() => this.terminateSandboxWithCheckpoint())));');
    expect(source).toContain('return this.withRuntimeMutation(() => this.withRuntimeTransition(() => this.withWorkspacePersistence(() => this.terminateSandboxWithCheckpoint(true))));');
    expect(source).toMatch(/this\.restartInProgress = true;\n    return this\.withRuntimeMutation\(\(\) => this\.withRuntimeTransition\(async \(\) => \{/);
    // Migration begin stops the runtime inside the same transition fence (C-7 writer fence).
    expect(source).toContain('if (this.containerIsRunning()) await this.withRuntimeTransition(async () => {\n            await this.stop();');
    // No other path stops the runtime outside the fence.
    expect(source.match(/await this\.stop\(\)/g)).toHaveLength(1);
    expect(source.match(/=> this\.stop\(\)/g)).toHaveLength(1);
  });
});
