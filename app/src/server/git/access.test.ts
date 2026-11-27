import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { GitAccessError, GRANT_RETRY_DELAY_MS, grantForStandaloneGit, STANDALONE_GIT_GRANT_URL } from './access';
import type { RetainedIdentity } from '@/server/auth/retained-identity';

const URL = 'https://github.ezil.work/default/os-code-url-20261110-a.git';
const NOW = Date.parse('2026-11-10T17:00:00.000Z');
const identity: RetainedIdentity = { token: 'private-id-token', issuer: 'https://id.ezil.work/', subject: 'auth0|qa-free2',
    expiresAt: NOW + 600_000, userId: 'user', sessionId: 'session' };
const packet = (scope: 'read' | 'write') => ({ version: 2,
    repository: { id: 'fg1wtcrexaf7acl0', canonicalURL: URL, ref: 'refs/heads/main' },
    identity: { issuer: identity.issuer, subject: identity.subject },
    git: { username: 'ezil', token: 'opaque-gateway-credential', expiresAt: '2026-11-10T17:04:00.000Z', scope } });
const capture = (respond: (scope: 'read' | 'write') => Response) => {
    const calls: Array<{ endpoint: string; init: RequestInit; body: { repoURL: string; scope: 'read' | 'write' } }> = [];
    const fetcher = vi.fn(async (endpoint: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ endpoint, init, body });
        return respond(body.scope);
    });
    return { calls, fetcher: fetcher as unknown as typeof fetch };
};
const failure = async (promise: Promise<unknown>, code: GitAccessError['code']) => {
    await expect(promise).rejects.toMatchObject({ code });
};

describe('standalone Git gateway access', () => {
    it('asks for write using the retained EZiL ID token and verifies the exact v2 packet', async () => {
        const { calls, fetcher } = capture(scope => Response.json(packet(scope)));
        expect(await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW })).toEqual(packet('write'));
        expect(calls).toHaveLength(1);
        expect(calls[0]!.endpoint).toBe(STANDALONE_GIT_GRANT_URL);
        expect(calls[0]!.body).toEqual({ repoURL: URL, scope: 'write' });
        expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${identity.token}`);
        expect(calls[0]!.endpoint).not.toContain(identity.token);
        expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    });
    it('retries read only after a 403 and reports the actual read scope', async () => {
        const { calls, fetcher } = capture(scope => scope === 'write' ? new Response(null, { status: 403 }) : Response.json(packet('read')));
        expect(await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW })).toEqual(packet('read'));
        expect(calls.map(call => call.body.scope)).toEqual(['write', 'read']);
    });
    it('never retries read after a 401 or accepts a false write claim', async () => {
        const refused = capture(() => new Response(null, { status: 401 }));
        await failure(grantForStandaloneGit(identity, URL, { fetch: refused.fetcher, now: () => NOW }), 'identity_refused');
        expect(refused.calls.map(call => call.body.scope)).toEqual(['write']);
        const mismatch = capture(() => Response.json(packet('read')));
        await failure(grantForStandaloneGit(identity, URL, { fetch: mismatch.fetcher, now: () => NOW }), 'invalid_response');
        expect(mismatch.calls.map(call => call.body.scope)).toEqual(['write']);
    });
    it('refuses substituted repository, subject, ref, and expired credentials', async () => {
        const changed = [
            { ...packet('write'), repository: { ...packet('write').repository, id: '../wrong' } },
            { ...packet('write'), repository: { ...packet('write').repository, canonicalURL: 'https://github.ezil.work/default/other.git' } },
            { ...packet('write'), repository: { ...packet('write').repository, ref: 'refs/heads/../bad' } },
            { ...packet('write'), identity: { ...packet('write').identity, subject: 'auth0|other' } },
            { ...packet('write'), git: { ...packet('write').git, expiresAt: '2026-11-10T16:59:00.000Z' } },
        ];
        for (const answer of changed) {
            const { fetcher } = capture(() => Response.json(answer));
            await failure(grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW }), 'invalid_response');
        }
    });
    it('sends no OAuth token for a noncanonical address', async () => {
        const { calls, fetcher } = capture(() => Response.json(packet('write')));
        await failure(grantForStandaloneGit(identity, 'https://github.ezil.work/default/../other.git', { fetch: fetcher, now: () => NOW }), 'invalid_response');
        expect(calls).toEqual([]);
    });
});

describe('a transient gateway answer does not end the grant, and nothing unsafe is ever repeated', () => {
    const quiet = async () => {};
    const sequence = (...answers: Array<() => Response | Promise<Response>>) => {
        const calls: Array<{ init: RequestInit; body: { repoURL: string; scope: 'read' | 'write' } }> = [];
        const fetcher = vi.fn(async (_endpoint: string, init: RequestInit) => {
            calls.push({ init, body: JSON.parse(String(init.body)) });
            const next = answers[Math.min(calls.length, answers.length) - 1]!;
            return next();
        });
        return { calls, fetcher: fetcher as unknown as typeof fetch };
    };
    const refusedConnect = (code: string) => () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code } }); };
    const tokenBody = () => Response.json({ git: { token: 'must-never-be-used-from-a-503' } }, { status: 503 });

    it('one gateway 503, then a valid packet: same identity, address and scope; one retry; the 503 body is never used', async () => {
        const { calls, fetcher } = sequence(tokenBody, () => Response.json(packet('write')));
        const retried: string[] = [];
        const sleeps: number[] = [];
        const granted = await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW,
            recover: true, sleep: async ms => { sleeps.push(ms); }, onRetry: why => retried.push(why) });
        expect(granted).toEqual(packet('write'));
        expect(calls).toHaveLength(2);
        expect(calls[1]!.body).toEqual(calls[0]!.body);
        expect(calls[1]!.body).toEqual({ repoURL: URL, scope: 'write' });
        expect(new Headers(calls[1]!.init.headers).get('authorization')).toBe(`Bearer ${identity.token}`);
        expect(retried).toEqual(['gateway_503']);
        expect(sleeps).toEqual([GRANT_RETRY_DELAY_MS]);
        expect(JSON.stringify(granted)).not.toContain('must-never-be-used');
    });
    it('a persistent 503 is one retry, never more, and ends as the same final unavailable', async () => {
        const { calls, fetcher } = sequence(tokenBody, tokenBody, () => Response.json(packet('write')));
        const error = await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true }).catch(e => e);
        expect(error).toBeInstanceOf(GitAccessError);
        expect(error).toMatchObject({ code: 'unavailable', retryable: false });
        expect(calls).toHaveLength(2);
    });
    it('a connect-phase failure (the request was never sent) is retried once; every other failure is final after one ask', async () => {
        for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
            const { calls, fetcher } = sequence(refusedConnect(code), () => Response.json(packet('write')));
            expect(await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true })).toEqual(packet('write'));
            expect(calls).toHaveLength(2);
        }
        const ambiguous: Array<() => never> = [
            refusedConnect('ECONNRESET'), refusedConnect('UND_ERR_SOCKET'), refusedConnect('ETIMEDOUT'),
            () => { throw new DOMException('timed out', 'TimeoutError'); }, () => { throw new DOMException('aborted', 'AbortError'); },
            () => { throw new TypeError('fetch failed'); },
        ];
        for (const fail of ambiguous) {
            const { calls, fetcher } = sequence(fail, () => Response.json(packet('write')));
            await failure(grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true }), 'unavailable');
            expect(calls, 'a request that may have been processed is not asked again').toHaveLength(1);
        }
    });
    it('definitive answers are never retried: 400, 401, 404, 429, 500, 502, 504 and a 200 with a bad body', async () => {
        const cases: Array<[number, GitAccessError['code']]> = [[400, 'unavailable'], [401, 'identity_refused'], [404, 'not_found'],
            [429, 'unavailable'], [500, 'unavailable'], [502, 'unavailable'], [504, 'unavailable']];
        for (const [status, code] of cases) {
            const { calls, fetcher } = sequence(() => new Response(null, { status }), () => Response.json(packet('write')));
            await failure(grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true }), code);
            expect(calls, `status ${status}`).toHaveLength(1);
        }
        const bad = sequence(() => new Response('not json', { status: 200 }), () => Response.json(packet('write')));
        await failure(grantForStandaloneGit(identity, URL, { fetch: bad.fetcher, now: () => NOW, sleep: quiet, recover: true }), 'invalid_response');
        expect(bad.calls).toHaveLength(1);
    });
    it('the permission fallback is unchanged and a transient 503 on the read ask repeats only the read ask', async () => {
        const { calls, fetcher } = sequence(() => new Response(null, { status: 403 }), tokenBody, () => Response.json(packet('read')));
        expect(await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true })).toEqual(packet('read'));
        expect(calls.map(call => call.body.scope)).toEqual(['write', 'read', 'read']);
    });
    it('no retry after the caller\'s own bound ends, and none when the backoff is interrupted', async () => {
        const controller = new AbortController();
        const { calls, fetcher } = sequence(tokenBody, () => Response.json(packet('write')));
        await failure(grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW, signal: controller.signal, recover: true,
            sleep: async () => { controller.abort(); throw new Error('aborted'); } }), 'unavailable');
        expect(calls).toHaveLength(1);
        const aborted = new AbortController();
        aborted.abort();
        const second = sequence(refusedConnect('ECONNREFUSED'), () => Response.json(packet('write')));
        await failure(grantForStandaloneGit(identity, URL, { fetch: second.fetcher, now: () => NOW, signal: aborted.signal, sleep: quiet, recover: true }), 'unavailable');
        expect(second.calls.length).toBeLessThanOrEqual(1);
    });
    it('without the opt-in every other caller is exactly as before: one ask, no sleep, no retry', async () => {
        const { calls, fetcher } = sequence(tokenBody, () => Response.json(packet('write')));
        await failure(grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW, sleep: async () => { throw new Error('slept'); } }), 'unavailable');
        expect(calls).toHaveLength(1);
        const connect = sequence(refusedConnect('ECONNREFUSED'), () => Response.json(packet('write')));
        await failure(grantForStandaloneGit(identity, URL, { fetch: connect.fetcher, now: () => NOW }), 'unavailable');
        expect(connect.calls).toHaveLength(1);
    });
    it('an expired or foreign identity and a noncanonical address are refused before any ask, so nothing is retried', async () => {
        const { calls, fetcher } = sequence(tokenBody, () => Response.json(packet('write')));
        await failure(grantForStandaloneGit({ ...identity, expiresAt: NOW - 1 }, URL, { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true }), 'identity_refused');
        await failure(grantForStandaloneGit({ ...identity, issuer: 'https://evil.example/' }, URL, { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true }), 'identity_refused');
        await failure(grantForStandaloneGit(identity, 'https://github.ezil.work/default/../x.git', { fetch: fetcher, now: () => NOW, sleep: quiet, recover: true }), 'invalid_response');
        expect(calls).toEqual([]);
    });
});

describe('one grant recovery budget and the original deadline', () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    it('has at most one recovery across write and permission fallback together', async () => {
        const scopes: string[] = [], retried: string[] = [];
        const answers = [503, 403, 503, 200];
        const fetcher = vi.fn(async (_input, init) => {
            const { scope } = JSON.parse(String(init.body)); scopes.push(scope);
            const status = answers[scopes.length - 1];
            return status === 200 ? Response.json(packet(scope)) : new Response(null, { status });
        });
        const result = await grantForStandaloneGit(identity, URL, { fetch: fetcher as typeof fetch, now: () => NOW,
            recover: true, sleep: async () => {}, onRetry: why => retried.push(why) }).catch(e => e);
        console.log('cross-scope observation', JSON.stringify({ scopes, retried, granted: result?.git?.scope }));
        expect(retried).toHaveLength(1);
        expect(scopes).toEqual(['write', 'write', 'read']);
        expect(result).toMatchObject({ code: 'unavailable' });
    });

    it('does not schedule recovery when abort wins immediately before the 503 continuation', async () => {
        vi.useFakeTimers();
        const controller = new AbortController(), retried: string[] = [];
        const fetcher = vi.fn(async (_input, init) => {
            if (init.signal.aborted) throw init.signal.reason; // native fetch also refuses before the wire
            controller.abort();
            return new Response(null, { status: 503 });
        });
        const started = Date.now();
        const result = grantForStandaloneGit(identity, URL, { fetch: fetcher as typeof fetch, now: () => NOW,
            recover: true, signal: controller.signal, onRetry: why => retried.push(why) }).catch(e => e);
        await vi.advanceTimersByTimeAsync(300);
        expect(await result).toMatchObject({ code: 'unavailable' });
        console.log('abort observation', JSON.stringify({ fetchInvocations: fetcher.mock.calls.length, retried, elapsed: Date.now() - started }));
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(retried).toEqual([]);
    });

    it('retains exactly one 10000ms timeout and the same signal through a late recovery', async () => {
        vi.useFakeTimers();
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
            return controller.signal;
        });
        const signals: AbortSignal[] = [];
        const fetcher = vi.fn(async (_input, init) => {
            signals.push(init.signal);
            if (signals.length === 1) {
                await new Promise(resolve => setTimeout(resolve, 8000));
                return new Response(null, { status: 503 });
            }
            return new Promise<Response>((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
        });
        let settled = false;
        const result = grantForStandaloneGit(identity, URL, { fetch: fetcher as typeof fetch, now: () => NOW,
            recover: true }).catch(e => e).then(value => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(9999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result).toMatchObject({ code: 'unavailable' });
        expect(signals).toHaveLength(2);
        expect(signals[0]).toBe(signals[1]);
        expect(timeout.mock.calls).toEqual([[10000]]);
    });

    it('does not exceed 10s when the timeout wins just before a 503 continuation', async () => {
        vi.useFakeTimers();
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
            return controller.signal;
        });
        const started = Date.now();
        const fetcher = vi.fn(async (_input, init) => {
            if (init.signal.aborted) throw init.signal.reason;
            await new Promise(resolve => setTimeout(resolve, 10000));
            return new Response(null, { status: 503 });
        });
        let settled = false;
        const result = grantForStandaloneGit(identity, URL, { fetch: fetcher as typeof fetch, now: () => NOW,
            recover: true }).catch(e => e).then(value => { settled = true; return value; });
        await vi.advanceTimersByTimeAsync(10000);
        const settledAtBound = settled;
        await vi.advanceTimersByTimeAsync(300);
        expect(await result).toMatchObject({ code: 'unavailable' });
        console.log('timeout-race observation', JSON.stringify({ settledAtBound, elapsed: Date.now() - started,
            fetchInvocations: fetcher.mock.calls.length }));
        expect(settledAtBound).toBe(true);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('aborting during ordinary backoff prevents a second fetch', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const fetcher = vi.fn(async () => new Response(null, { status: 503 }));
        const result = grantForStandaloneGit(identity, URL, { fetch: fetcher as typeof fetch, now: () => NOW,
            recover: true, signal: controller.signal }).catch(e => e);
        await vi.advanceTimersByTimeAsync(100);
        controller.abort();
        expect(await result).toMatchObject({ code: 'unavailable' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

});
