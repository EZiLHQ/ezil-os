// Seam harness: the Worker's REAL delegated Browser observation client (aws-origin.ts observeAwsBrowser:
// gw1 signing, the exact bytes and their path digest) against the host's REAL edge on a loopback socket,
// in front of a REAL agent (desktop_status before and after). Only the desktop is replaced
// (infra/host-agent/test/browser_observe_edge_seam_server.py): its stub sidecar answers a session id
// derived from the bytes it received. Needs python3; the driver removes its own temp dir.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { observeAwsBrowser, type AwsTunnelRecord } from './aws-origin';

const COMPUTER = '22222222-2222-4222-8222-222222222222';
const NAME = 'guac-1111111111114111-2222222222224222';
const KEY = Buffer.alloc(32, 9).toString('base64');
const GEN = 6, EPOCH = 11;
const DRIVER = path.resolve(import.meta.dir, '../../infra/host-agent/test/browser_observe_edge_seam_server.py');
const record = (over: Partial<AwsTunnelRecord> = {}): AwsTunnelRecord => ({ computerId: COMPUTER, sandboxId: NAME, generation: GEN, leaseEpoch: EPOCH,
  instanceId: 'i-0abc', region: 'test-region-1', publicIp: '192.0.2.1', tunnelId: 't', dnsRecordId: 'd', hostname: 'h', controlKey: KEY,
  createdAt: 0, originVerified: true, ...over });
const bytes = (text: string) => new TextEncoder().encode(text);
const now = () => Math.floor(Date.now() / 1000);

interface Host { child: ChildProcess; port: number }
async function startHost(enabled: boolean): Promise<Host> {
  const child = spawn('python3', ['-B', DRIVER, JSON.stringify({ key: KEY, computerId: COMPUTER, generation: GEN, leaseEpoch: EPOCH, enabled })],
    { stdio: ['pipe', 'pipe', 'inherit'] });
  const line = await new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once('line', resolve);
    child.once('exit', code => reject(new Error(`the edge driver exited (${code}) before listening`)));
  });
  return { child, port: (JSON.parse(line) as { port: number }).port };
}
function stopHost(host: Host | undefined) {
  if (!host) return;
  host.child.stdin?.end();
  if (host.child.exitCode === null) setTimeout(() => { if (host.child.exitCode === null) host.child.kill(); }, 2000).unref();
}
/** The Worker's fetch, aimed at the loopback edge (the tunnel's job); the request is otherwise untouched. */
const toEdge = (host: Host, tamper?: (init: RequestInit) => RequestInit) => async (input: string, init: RequestInit) => {
  const url = new URL(input);
  expect(url.protocol).toBe('https:');
  return fetch(`http://127.0.0.1:${host.port}${url.pathname}${url.search}`, tamper ? tamper(init) : init);
};

describe('seam W ↔ H: delegated Browser observation through the host\'s real edge and agent', () => {
  let host: Host;
  let off: Host;
  beforeAll(async () => { [host, off] = await Promise.all([startHost(true), startHost(false)]); });
  afterAll(() => { stopHost(host); stopHost(off); });

  it('the exact signed bytes reach the fixed sidecar route and only the closed envelope returns', async () => {
    for (const text of [`{"binding":"${'a'.repeat(64)}"}`, `{ "binding": "${'b'.repeat(64)}", "browserSessionId": "${'c'.repeat(43)}" }`]) {
      const res = await observeAwsBrowser(record(), 'ezil.work', bytes(text), toEdge(host), now(), 6_000);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true, browserSessionId: createHash('sha256').update(text).digest('base64url'), expiresAt: '2026-11-20T00:02:00.000Z',
        observed: 'profile_builder', profileHeadingVisible: true, universeIdentity: 'unverified',
      });
    }
  });

  it('another key or epoch is 401, other bytes than the signed digest or a widened body are 400, the host flag off is 404', async () => {
    const body = bytes(`{"binding":"${'a'.repeat(64)}"}`);
    for (const bad of [record({ controlKey: Buffer.alloc(32, 1).toString('base64') }), record({ leaseEpoch: EPOCH + 1 }), record({ generation: GEN + 1 })]) {
      expect((await observeAwsBrowser(bad, 'ezil.work', body, toEdge(host), now(), 6_000)).status).toBe(401);
    }
    const swapped = toEdge(host, init => ({ ...init, body: bytes(`{"binding":"${'f'.repeat(64)}"}`) }));
    expect((await observeAwsBrowser(record(), 'ezil.work', body, swapped, now(), 6_000)).status).toBe(400);
    const widened = bytes(`{"binding":"${'a'.repeat(64)}","selector":"input"}`);
    expect((await observeAwsBrowser(record(), 'ezil.work', widened, toEdge(host), now(), 6_000)).status).toBe(400);
    expect((await observeAwsBrowser(record(), 'ezil.work', body, toEdge(off), now(), 6_000)).status).toBe(404);
  });
});
