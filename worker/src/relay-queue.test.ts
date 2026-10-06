import { describe, expect, it, mock } from 'bun:test';
mock.module('cloudflare:workers', () => ({ DurableObject: class {}, WorkerEntrypoint: class {}, RpcTarget: class {}, RpcStub: class {}, env: {} }));

describe('relay RPC checkpoint contention', () => {
  it('waits through a normal checkpoint and returns typed expiry failures before container access', async () => {
    const { Sandbox } = await import('./index');
    const realNow = Date.now;
    const run = async (queueMs: number) => {
      let time = 1000, release!: () => void;
      const paths: string[] = [];
      const queued = new Promise<void>(resolve => { release = resolve; });
      const fake = Object.assign(Object.create(Sandbox.prototype), {
        runtimeMutationTail: queued,
        env: { SANDBOX_HMAC_SECRET: 'queue-test-only' },
        ctx: { container: { running: true, getTcpPort: () => ({ fetch: async (url: string) => {
          const path = new URL(url).pathname; paths.push(path);
          if (path === '/api/login') return Response.json({token:'private-test-token'});
          if (path === '/api/logout') return new Response(null, {status:204});
          return Response.json({runtimeId:'a'.repeat(32),expiresAt:400000});
        } }) } },
      });
      Date.now = () => time;
      try {
        const pending = fake.relayRefresh('guac-queue-test');
        time += queueMs; release();
        return {result:await pending,paths};
      } finally { Date.now = realNow; }
    };
    const checkpoint = await run(5500);
    expect(checkpoint.result).toEqual({ok:true,runtimeId:'a'.repeat(32),expiresAt:400000});
    expect(checkpoint.paths).toEqual(['/api/login','/api/relay','/api/logout']);
    const expired = await run(27000);
    expect(JSON.parse(JSON.stringify(expired.result))).toEqual({ok:false,error:'relay_busy',status:409});
    expect(expired.paths).toEqual([]);
  });
});
