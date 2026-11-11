import { describe, expect, it } from 'bun:test';
import { openAwsStandaloneRepo, type AwsRepoOpenDeps } from './aws-repo-open';
import { verifyGatewayHeader, decodeControlKey, type AwsTunnelRecord } from './aws-origin';
import type { PreviewTokenV2Claims } from './hmac';
const now = 1_794_405_600_000;
const uid = '11111111-1111-4111-8111-111111111111', cid = '22222222-2222-4222-8222-222222222222';
const sid = 'guac-1111111111114111-2222222222224222', rid = '44444444-4444-4444-8444-444444444444';
const job = 'a'.repeat(64), token = 'opaque-fixture-native-token';
const claims: PreviewTokenV2Claims = { ts: now, userId: uid, computerId: cid, sandboxId: sid, provider: 'aws-ec2', store: '', generation: 2, leaseEpoch: 4 };
const record = { computerId: cid, sandboxId: sid, generation: 2, leaseEpoch: 4, originVerified: true,
 controlKey: btoa('k'.repeat(32)) } as AwsTunnelRecord;
const raw = () => ({ repositoryId: rid, timeoutMs: 60_000, privatePacket: { version: 2,
 repository: { id: 'provider1', canonicalURL: 'https://github.ezil.work/default/fixture.git', ref: 'refs/heads/main' },
 identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|fixture' },
 git: { username: 'ezil', token, scope: 'read', expiresAt: new Date(now + 240_000).toISOString() } } });
const success = { ok: true, state: 'done', result: { ok: true, folder: `/workspace/projects/${rid}`, status: 'cloned' } };
function setup() {
 let clock = now, lookups = 0;
 const calls: Array<{ url: string; init: RequestInit }> = [];
 const answers: Response[] = [Response.json({ ok: true, state: 'running' }, { status: 202 }), Response.json(success)];
 let lookup = async () => record;
 const deps: AwsRepoOpenDeps = { enabled: true, zone: 'origin.example.net', now: () => clock, jobId: () => job,
   lookup: async () => { lookups++; return lookup(); },
   sleep: async ms => { clock += ms; },
   fetch: async (url, init) => { calls.push({ url, init }); return answers.shift()!; } };
 const run = (body: unknown = raw(), c = claims, signal?: AbortSignal) => openAwsStandaloneRepo(
   new Request('https://worker.example/path', { signal }), c, sid, body, deps);
 return { deps, calls, answers, run, lookups: () => lookups, setLookup: (v: typeof lookup) => { lookup = v; }, advance: (ms: number) => { clock += ms; } };
}
describe('AWS standalone repository operation', () => {
 it('signs exact UTF8 admission digest, polls job only, and validates final current placement', async () => {
   const f = setup();
   const response = await f.run();
   expect(response.status).toBe(200);
   expect(await response.json()).toEqual(success.result);
   expect(f.lookups()).toBe(3);
   const [post, get] = f.calls;
   const body = String(post!.init.body), encoded = new TextEncoder().encode(body);
   const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)), b => b.toString(16).padStart(2, '0')).join('');
   expect(new URL(post!.url).pathname).toBe(`/__ezil/control/standalone-repo-open/${digest}`);
   expect(JSON.parse(body)).toEqual({ v: 1, jobId: job, ...raw() });
   expect(new Headers(post!.init.headers).get('content-length')).toBe(String(encoded.length));
   for (const call of f.calls) {
     expect(call.init.redirect).toBe('manual');
     expect(call.url).not.toContain(token);
     expect(new URL(call.url).search).toBe('');
     expect(await verifyGatewayHeader(new Headers(call.init.headers).get('x-ezil-gw'), decodeControlKey(record.controlKey)!,
       record, call.init.method!, new URL(call.url).pathname, now / 1000)).toEqual({ ok: true });
   }
   expect(new URL(get!.url).pathname).toBe(`/__ezil/control/standalone-repo-open-status/${job}`);
   expect(get!.init.body).toBeUndefined();
 });
 it('is off by default and refuses foreign, store-backed, non-derived or stale claims before host calls', async () => {
   for (const change of [{ store: 's3' }, { generation: 0 }, { leaseEpoch: 0 }, { computerId: uid }, { provider: 'cloudflare' }]) {
     const f = setup();
     expect((await f.run(raw(), { ...claims, ...change } as PreviewTokenV2Claims)).status).not.toBe(200);
     expect(f.calls).toHaveLength(0);
   }
   const f = setup(); f.deps.enabled = false;
   expect((await f.run()).status).toBe(409); expect(f.calls).toHaveLength(0);
 });
 it('checks placement before admission, every poll and after completed status', async () => {
   for (const badAt of [1, 2, 3]) {
     const f = setup(); let count = 0;
     f.setLookup(async () => ++count === badAt ? { ...record, leaseEpoch: 5 } : record);
     expect((await f.run()).status).toBe(502);
     expect(f.calls.length).toBe(badAt - 1);
   }
 });
 it('rejects a completion that crosses deadline during final lookup', async () => {
   const f = setup(); let count = 0;
   f.setLookup(async () => { if (++count === 3) f.advance(60_001); return record; });
   expect(await (await f.run()).json()).toEqual({ ok: false, error: 'repo_open_timeout' });
 });
 it('refuses unbound, extra-field, wrong-folder and unknown-status completions', async () => {
   for (const result of [{ ...success.result, folder: '/workspace' }, { ...success.result, status: 'created' },
     { ...success.result, token }, { ok: true, folder: success.result.folder }, { ok: false, error: token }]) {
     const f = setup(); f.answers[1] = Response.json({ ok: true, state: 'done', result });
     const res = await f.run(); expect(res.status).toBe(502); expect(await res.text()).not.toContain(token);
   }
 });
 it('bounds grant lifetime, refuses public GitHub/legacy requests and handles old host without fallback', async () => {
   for (const body of [{ ...raw(), timeoutMs: 130_000, privatePacket: { ...raw().privatePacket,
     git: { ...raw().privatePacket.git, expiresAt: new Date(now + 130_000).toISOString() } } },
     { repositoryId: rid, canonicalURL: 'https://github.com/owner/repo.git', ref: 'refs/heads/main', timeoutMs: 60_000 }]) {
     const f = setup(); expect((await f.run(body)).status).not.toBe(200); expect(f.calls).toHaveLength(0);
   }
   const f = setup(); f.answers[0] = new Response('', { status: 404 });
   expect(await (await f.run()).json()).toEqual({ ok: false, error: 'repo_open_unsupported_provider' });
   expect(f.calls).toHaveLength(1);
 });
 it('aborts caller cancellation before host admission and stops polling at hard deadline', async () => {
   const f = setup(), c = new AbortController(); c.abort();
   expect((await f.run(raw(), claims, c.signal)).status).toBe(502); expect(f.calls).toHaveLength(0);
   const g = setup(); g.answers[1] = Response.json({ ok: true, state: 'running' });
   g.deps.sleep = async () => { g.advance(60_001); };
   expect(await (await g.run()).json()).toEqual({ ok: false, error: 'repo_open_timeout' });
   expect(g.calls).toHaveLength(2);
 });
});

