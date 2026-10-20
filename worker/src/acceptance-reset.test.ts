import { describe, expect, it, mock } from 'bun:test';
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {} }));

const sandbox = 'guac-abcdef0123456789-fedcba9876543210';
const pending = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fakeObject({ running = false, checkpoint, env }: { running?: boolean; checkpoint?: Promise<void>; env?: Record<string, string> } = {}) {
  const { Sandbox, ACCEPTANCE_RESET_DELAY_MS } = await import('./index');
  const aborts: string[] = [];
  const fake = Object.assign(Object.create(Sandbox.prototype), {
    // A checkpoint in flight holds both persistence locks, as a teardown's final
    // checkpoint and the scheduled flush cycle do.
    runtimeMutationTail: checkpoint ?? Promise.resolve(),
    workspacePersistenceTail: checkpoint ?? Promise.resolve(),
    env: env ?? { EZIL_ACCEPTANCE_ENV: 'staging', EZIL_ACCEPTANCE_SANDBOX: sandbox },
    ctx: { container: { running }, abort: (reason: string) => { aborts.push(reason); } },
  });
  return { fake, aborts, delay: ACCEPTANCE_RESET_DELAY_MS as number };
}

describe('acceptance reset onto the deployed code', () => {
  it('resets a stopped test computer only after replying', async () => {
    const { fake, aborts, delay } = await fakeObject();
    expect(await fake.resetRuntimeForAcceptance(sandbox)).toEqual({ ok: true });
    // The reply leaves the object before it is discarded.
    expect(aborts).toEqual([]);
    await sleep(delay + 50);
    expect(aborts).toEqual(['acceptance_reset']);
  });

  it('never resets a running computer', async () => {
    const { fake, aborts, delay } = await fakeObject({ running: true });
    expect(await fake.resetRuntimeForAcceptance(sandbox)).toEqual({ ok: false, error: 'runtime_running' });
    await sleep(delay + 50);
    expect(aborts).toEqual([]);
  });

  it('refuses outside the staging acceptance scope and for any other computer', async () => {
    for (const env of [{}, { EZIL_ACCEPTANCE_ENV: 'production', EZIL_ACCEPTANCE_SANDBOX: sandbox },
      { EZIL_ACCEPTANCE_ENV: 'staging', EZIL_ACCEPTANCE_SANDBOX: 'guac-other-computer' }]) {
      const { fake, aborts, delay } = await fakeObject({ env });
      await expect(fake.resetRuntimeForAcceptance(sandbox)).rejects.toThrow('acceptance_faults_disabled');
      await sleep(delay + 50);
      expect(aborts).toEqual([]);
    }
    const { fake, aborts } = await fakeObject();
    await expect(fake.resetRuntimeForAcceptance('guac-other-computer')).rejects.toThrow('acceptance_faults_disabled');
    expect(aborts).toEqual([]);
  });

  it('waits for an in-flight checkpoint before scheduling the reset', async () => {
    const checkpoint = pending();
    const { fake, aborts, delay } = await fakeObject({ checkpoint: checkpoint.promise });
    let settled = false;
    const reset = fake.resetRuntimeForAcceptance(sandbox).then((value: unknown) => { settled = true; return value; });
    await sleep(delay + 50);
    expect(settled).toBe(false);
    expect(aborts).toEqual([]);
    checkpoint.release();
    expect(await reset).toEqual({ ok: true });
    await sleep(delay + 50);
    expect(aborts).toEqual(['acceptance_reset']);
  });
});
