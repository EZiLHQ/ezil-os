import { describe, expect, it } from 'bun:test';
import { authorizeAssignmentPreload } from './assignment-preload';
import { openAwsStandaloneRepo, REPO_OPEN_DIAGNOSTIC_REASONS, type AwsRepoOpenDeps } from './aws-repo-open';
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
 it('binds optional author and refresh-only metadata in the signed host body', async () => {
   const f = setup(), gitAuthor = { name: 'Contact', email: 'contact@ezil.work' };
   expect((await f.run({ ...raw(), gitAuthor, refreshOnly: true })).status).toBe(200);
   expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ v: 1, jobId: job, ...raw(), gitAuthor, refreshOnly: true });
   expect(f.calls[0]!.url).not.toContain(gitAuthor.email);
 });
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
 it('forwards only a scoped staging assignment and returns the nonce from the verified AWS host', async () => {
   const attemptId = '44444444-4444-4444-8444-444444444444';
   const eventId = '55555555-5555-4555-8555-555555555555';
   const hash = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
     new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('');
   const ownerSha256 = await hash(raw().privatePacket.identity.subject);
   const canonicalURL = `https://github.ezil.work/default/u-${ownerSha256.slice(0, 16)}-a-${attemptId}.git`;
   const id = (await hash(`ezil-os/repo-url/v1|${canonicalURL}`)).slice(0, 32).split('');
   id[12] = '8'; id[16] = '89ab'[parseInt(id[16]!, 16) & 3]!;
   const joined = id.join('');
   const repositoryId = [joined.slice(0, 8), joined.slice(8, 12), joined.slice(12, 16), joined.slice(16, 20), joined.slice(20)].join('-');
   const assignmentPreload = { eventId, attemptId, manifestSha256: 'f'.repeat(64), nonce: 'e'.repeat(64) };
   const input = raw();
   input.privatePacket.repository.canonicalURL = canonicalURL;
   input.privatePacket.git.scope = 'write';
   const payload = { ...input, repositoryId, assignmentPreload };
   const folder = `/workspace/projects/${repositoryId}`;
   const ack = { eventId, nonce: assignmentPreload.nonce, port: 5679, status: 'acknowledged' };
   const qualified = { ok: true, folder, status: 'fetched',
     checkoutFolder: folder + '/' + canonicalURL.split('/').at(-1)!.slice(0, -4), assignmentPreload: ack };
   const configure = (gateway = 'https://ai-staging.ezil.work') => {
     const f = setup();
     f.deps.authorizeAssignment = (challenge, req) =>
       authorizeAssignmentPreload(challenge, req, { EZIL_AI_GATEWAY_URL: gateway });
     return f;
   };
   const f = configure();
   f.answers[1] = Response.json({ ...success, result: qualified });
   expect(await (await f.run(payload)).json()).toEqual(qualified);
   expect(JSON.parse(String(f.calls[0]!.init.body)).assignmentPreload).toMatchObject({
     ...assignmentPreload, ownerSha256, canonicalURL, repositoryId, ref: 'refs/heads/main',
   });
   for (const bad of [success.result, { ...qualified, checkoutFolder: folder }, { ...qualified,
     assignmentPreload: { ...ack, nonce: '0'.repeat(64) } }]) {
     const rejected = configure(); rejected.answers[1] = Response.json({ ...success, result: bad });
     expect((await rejected.run(payload)).status).toBe(502);
   }
   for (const unqualified of [setup(), configure('https://ai.ezil.work')]) {
     expect((await unqualified.run(payload)).status).toBe(400);
     expect(unqualified.calls).toHaveLength(0);
   }
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
   expect(await (await f.run()).json()).toEqual({ ok: false, error: 'repo_open_timeout', diagnosticReason: 'budget_exhausted' });
 });
 it('refuses unbound, extra-field, wrong-folder and unknown-status completions', async () => {
   for (const result of [{ ...success.result, folder: '/workspace' }, { ...success.result, status: 'created' },
     { ...success.result, token }, { ok: true, folder: success.result.folder }, { ok: false, error: token }]) {
     const f = setup(); f.answers[1] = Response.json({ ok: true, state: 'done', result });
     const res = await f.run(); expect(res.status).toBe(502); expect(await res.text()).not.toContain(token);
   }
 });
 it('forwards only closed host failure reasons while preserving legacy error-only replies', async () => {
   for (const diagnosticReason of REPO_OPEN_DIAGNOSTIC_REASONS) {
     const f = setup(); const result = { ok: false, error: 'repo_open_failed', diagnosticReason };
     f.answers[1] = Response.json({ ok: true, state: 'done', result });
     expect(await (await f.run()).json()).toEqual(result);
   }
   const old = setup(); old.answers[1] = Response.json({ ok: true, state: 'done', result: { ok: false, error: 'repo_open_failed' } });
   expect(await (await old.run()).json()).toEqual({ ok: false, error: 'repo_open_failed' });
 });
 it('drops raw, unknown, nonstring and extra-field host diagnostics without weakening completion checks', async () => {
   for (const change of [{ diagnosticReason: token }, { diagnosticReason: 'provider private detail' },
     { diagnosticReason: null }, { diagnosticReason: ['clone_failed'] },
     { diagnosticReason: 'clone_failed', privateDetail: token }]) {
     const f = setup(); f.answers[1] = Response.json({ ok: true, state: 'done', result: { ok: false, error: 'repo_open_failed', ...change } });
     const response = await f.run(); expect(response.status).toBe(502);
     expect(await response.json()).toEqual({ ok: false, error: 'repo_open_failed', diagnosticReason: 'invalid_result' });
   }
   const successWithReason = setup();
   successWithReason.answers[1] = Response.json({ ...success, result: { ...success.result, diagnosticReason: 'clone_failed' } });
   expect(await (await successWithReason.run()).json()).toEqual({ ok: false, error: 'repo_open_failed', diagnosticReason: 'invalid_result' });
 });
 it('maps admission refusals without returning provider text or retrying a rejected job', async () => {
   for (const [error, diagnosticReason] of [['workspace_busy', 'checkout_busy'], ['stopping', 'admission_stopping'],
     ['runtime_not_running', 'runtime_not_running'], ['standalone_repo_invalid', 'admission_invalid'],
     [token, 'admission_rejected']]) {
     const f = setup(); f.answers[0] = Response.json({ ok: false, error }, { status: 409 });
     expect(await (await f.run()).json()).toEqual({ ok: false, error: 'repo_open_failed', diagnosticReason });
     expect(f.calls).toHaveLength(1);
   }
   const f = setup(); f.answers[0] = new Response(token, { status: 503 });
   expect(await (await f.run()).json()).toEqual({ ok: false, error: 'repo_open_failed', diagnosticReason: 'admission_rejected' });
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
   expect(await (await g.run()).json()).toEqual({ ok: false, error: 'repo_open_timeout', diagnosticReason: 'budget_exhausted' });
   expect(g.calls).toHaveLength(2);
 });
});

