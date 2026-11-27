import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ enabled: vi.fn(), exchangeCode: vi.fn(), verifyIdToken: vi.fn(), bridge: vi.fn(), refuseSwitch: vi.fn(), retain: vi.fn() }));
vi.mock('./auth0', async original => ({ ...await original<typeof import('./auth0')>(), exchangeCode: stub.exchangeCode, verifyIdToken: stub.verifyIdToken }));
vi.mock('./bridge', () => ({ bridgeAuth0Identity: stub.bridge, refuseSilentAccountSwitch: stub.refuseSwitch }));
vi.mock('./retained-identity', () => ({ retainProjectIdentity: stub.retain }));
// The real owner-bound repository name; only the stage switch is stubbed.
vi.mock('@/server/git/assignment-enrollment', async original => ({
    ...await original<typeof import('@/server/git/assignment-enrollment')>(), assignmentEnrollmentEnabled: stub.enabled }));

import { ownerRepositoryName } from '@/server/git/assignment-enrollment';
import { AUTH0_COOKIE, Auth0Error } from './auth0';
import { isWorkAuthCallback, settleWorkAuth, startWorkAuth, WORK_AUTH_COOKIE, workAuthScript } from './work-auth';

const os = 'https://os-staging.ezil.work', universe = 'https://universe-staging.ezil.work';
const prodOs = 'https://os.ezil.work', prodUniverse = 'https://universe.ezil.work';
const WORK_AUTH_SCRIPT = workAuthScript({ os, universe });
/** The page's one inline script, read by position: the page is ours and carries exactly one. */
const inlineScript = (html: string) => { const open = '<script>', start = html.indexOf(open), end = html.lastIndexOf('</script>');
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start); expect(html.indexOf(open, start + 1)).toBe(-1);
    return html.slice(start + open.length, end); };
const stageEnv = () => { vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work'); vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED', '');
    vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN', universe); };
const productionEnv = () => { vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work'); vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED', '1');
    vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN', prodUniverse); };
const attempt = 'ba4cf399-1f9b-43e5-be10-45e403bc0190', request = '6f0c1d2e-3a4b-4c5d-8e6f-7a8b9c0d1e2f';
const subject = 'auth0|builder', email = 'private-person@example.com', secret = 'client-secret-never-shown';
const owner = ownerRepositoryName(subject, 'a-' + attempt).slice(2, 18);
const attemptTag = '8c472e1bbbcb7f77';
const frame = { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' };
const mine = WORK_AUTH_COOKIE + '-' + request;
const query = (fields: Record<string, string> = { attempt, owner, request }) => '/assignment/work-auth?' + new URLSearchParams(fields);
let lines: string[];

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv('AUTH0_CLIENT_ID', 'stage-client'); vi.stubEnv('AUTH0_SECRET_ID', secret);
    stageEnv();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
    stub.enabled.mockReturnValue(true);
    stub.exchangeCode.mockResolvedValue('private-id-token');
    stub.verifyIdToken.mockResolvedValue({ sub: subject, email });
    stub.refuseSwitch.mockResolvedValue(undefined);
    stub.bridge.mockResolvedValue(undefined);
    stub.retain.mockResolvedValue(undefined);
    lines = [];
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

function begin(path = query(), headers: Record<string, string> = frame, host = os) {
    return startWorkAuth(new Request(host + path, { headers }));
}
/** Extract the single canonical inline script from our generated response, for exact content/CSP assertions. */
function inlineScript(html: string) {
    const opening = html.split('<script>');
    expect(opening).toHaveLength(2);
    const closing = opening[1]!.split('</script>');
    expect(closing).toHaveLength(2);
    expect(closing[1]).toBe('</body></html>');
    return closing[0]!;
}
/** A started transaction: its cookie pair, its state and the decoded payload. */
function started(path = query()) {
    const response = begin(path);
    const jar = response.headers.get('set-cookie')!.split(';')[0]!;
    const authorize = new URL(response.headers.get('location')!);
    const tx = JSON.parse(Buffer.from(jar.slice(jar.indexOf('=') + 1).split('.')[0]!, 'base64url').toString());
    return { response, jar, authorize, state: authorize.searchParams.get('state')!, tx: tx as Record<string, string | number> };
}
function callback(params: Record<string, string>, jar: string | null, headers: Record<string, string> = { 'sec-fetch-dest': 'iframe' }, host = os) {
    return settleWorkAuth(new Request(host + '/auth/auth0/callback?' + new URLSearchParams(params), { headers: { ...headers, ...(jar ? { cookie: 'other=1; ' + jar } : {}) } }));
}
const outcomeOf = (html: string) => /data-outcome="([a-z_]+)"/.exec(html)?.[1];
/** Every answer of this flow: a 200 document that goes nowhere. */
async function inert(response: Response) {
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await response.text();
    // Spends exactly the cookie of the request it names, and no other; names none, touches none.
    const named = /data-request="([0-9a-f-]{36})"/.exec(html)?.[1];
    expect(response.headers.get('set-cookie')).toBe(named ? `${WORK_AUTH_COOKIE}-${named}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` : null);
    // No link, form, frame or redirect of its own, and nothing private.
    expect(html).not.toMatch(/<a |<form|<iframe|http-equiv|location\.(href|assign|replace)/i);
    for (const hidden of ['private-code', 'private-id-token', subject, email, secret, owner, '/login', 'authorize']) expect(html).not.toContain(hidden);
    return html;
}

describe('the hidden child starts one scoped, silent-only EZiL ID transaction', () => {
    it('sends prompt=none with its own state, nonce and S256 PKCE to the registered callback', () => {
        const { response, authorize, state, tx, jar } = started();
        expect(response.status).toBe(303);
        expect(authorize.origin + authorize.pathname).toBe('https://id.ezil.work/authorize');
        expect(Object.fromEntries(authorize.searchParams)).toEqual({
            client_id: 'stage-client', response_type: 'code', scope: 'openid email profile', redirect_uri: os + '/auth/auth0/callback',
            state, nonce: tx.nonce, code_challenge: createHash('sha256').update(String(tx.codeVerifier)).digest('base64url'),
            code_challenge_method: 'S256', prompt: 'none',
        });
        expect(state).toMatch(new RegExp('^ezw1\\.' + request + '\\.[\\w-]{43}$'));
        expect(tx).toMatchObject({ state, attempt, owner, request });
        expect(String(tx.nonce)).toMatch(/^[\w-]{43}$/);
        expect(String(tx.codeVerifier)).toMatch(/^[\w-]{43}$/);
        expect(Number(tx.expiresAt) - Date.now()).toBeGreaterThan(110_000);
        expect(Number(tx.expiresAt) - Date.now()).toBeLessThanOrEqual(120_000);
        // Its own host-only cookie; the interactive sign-in's is never written.
        expect(response.headers.get('set-cookie')).toBe(jar + '; Path=/; Max-Age=120; HttpOnly; Secure; SameSite=Lax');
        expect(jar.startsWith(mine + '=')).toBe(true);
        expect(response.headers.get('set-cookie')).not.toContain(AUTH0_COOKIE);
        expect(response.headers.get('cache-control')).toContain('no-store');
        // The hop carries no framing header of its own.
        expect(response.headers.get('content-security-policy')).toBeNull();
        expect(response.headers.get('x-frame-options')).toBeNull();
        // Nothing about the assignment or the person travels to id.ezil.work.
        for (const hidden of [attempt, owner, secret]) expect(authorize.href).not.toContain(hidden);
        expect(lines).toEqual([JSON.stringify({ event: 'ezil_assignment_work_auth', outcome: 'started', attemptTag })]);
    });
    it('two starts never share a state, nonce or verifier', () => {
        const [a, b] = [started().tx, started().tx];
        for (const key of ['state', 'nonce', 'codeVerifier']) expect(a[key]).not.toBe(b[key]);
    });
    it.each([
        ['a top-level document', query(), { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' }, os],
        ['no fetch metadata', query(), {}, os],
        ['a frame navigated by Universe', query(), { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' }, os],
        ['a frame navigated by another site', query(), { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' }, os],
        ['production', query(), frame, 'https://os.ezil.work'],
        ['an extra parameter', query({ attempt, owner, request, returnUrl: '/os' }), frame, os],
        ['a repeated parameter', query() + '&owner=' + owner, frame, os],
        ['a missing owner', query({ attempt, request }), frame, os],
        ['an uppercase attempt', query({ attempt: attempt.toUpperCase(), owner, request }), frame, os],
        ['a malformed owner', query({ attempt, owner: owner.slice(1), request }), frame, os],
        ['a malformed request id', query({ attempt, owner, request: 'x' }), frame, os],
    ])('refuses %s without a cookie, a redirect or a log line', (_name, path, headers, host) => {
        const response = begin(path, headers, host);
        expect(response.status).toBe(404);
        expect(response.headers.get('location')).toBeNull();
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        expect(lines).toEqual([]);
    });
    it('refuses when the stage switch or EZiL ID is off', () => {
        stub.enabled.mockReturnValueOnce(false);
        expect(begin().status).toBe(404);
        vi.stubEnv('AUTH0_CLIENT_ID', '');
        expect(begin().status).toBe(404);
    });
});

describe('the callback answer: success', () => {
    it('🔴 verifies the token, binds its subject to the assigned owner and checks the OS account BEFORE any session exists', async () => {
        const { jar, state, tx } = started();
        lines = [];
        const response = await callback({ state, code: 'private-code' }, jar);
        const html = await inert(response);
        expect(outcomeOf(html)).toBe('signed_in');
        expect(html).toContain(`data-request="${request}"`);
        expect(html).toContain(`data-attempt="${attempt}"`);
        expect(stub.exchangeCode).toHaveBeenCalledWith('private-code', { origin: os, codeVerifier: tx.codeVerifier });
        expect(stub.verifyIdToken).toHaveBeenCalledWith('private-id-token', { nonce: tx.nonce });
        expect(stub.refuseSwitch).toHaveBeenCalledWith({ sub: subject, email });
        expect(stub.bridge).toHaveBeenCalledWith({ sub: subject, email });
        expect(stub.retain).toHaveBeenCalledWith('private-id-token');
        const order = [stub.exchangeCode, stub.verifyIdToken, stub.refuseSwitch, stub.bridge, stub.retain].map(fn => fn.mock.invocationCallOrder[0]!);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(lines).toEqual([JSON.stringify({ event: 'ezil_assignment_work_auth', outcome: 'signed_in', attemptTag })]);
    });
    it('pins the one script by hash and allows exactly the OS frame under the Universe tab', async () => {
        const { jar, state } = started();
        const response = await callback({ state, code: 'private-code' }, jar);
        const policy = response.headers.get('content-security-policy')!;
        const html = await response.text();
        const script = inlineScript(html);
        expect(script).toBe(WORK_AUTH_SCRIPT);
        expect(policy).toBe(`default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors ${os} ${universe}`);
        expect(policy).not.toContain('*');
    });
    it('an identity that could not be retained is still a sign-in; the editor asks for a refresh itself', async () => {
        const { jar, state } = started();
        stub.retain.mockRejectedValue(new Error('vault_unavailable'));
        expect(outcomeOf(await inert(await callback({ state, code: 'private-code' }, jar)))).toBe('signed_in');
    });
});

describe('the callback answer: denial never becomes an interactive sign-in', () => {
    it.each(['login_required', 'interaction_required', 'consent_required'])('%s is sign_in_required, with no code exchange and no session', async error => {
        const { jar, state } = started();
        lines = [];
        const html = await inert(await callback({ state, error, error_description: 'private-person@example.com' }, jar));
        expect(outcomeOf(html)).toBe('sign_in_required');
        expect(html).toContain(`data-request="${request}"`);
        for (const call of Object.values(stub)) if (call !== stub.enabled) expect(call).not.toHaveBeenCalled();
        expect(lines).toEqual([JSON.stringify({ event: 'ezil_assignment_work_auth', outcome: 'sign_in_required', attemptTag })]);
    });
    it.each([['another provider error', { error: 'access_denied' }], ['no code', {}], ['an empty code', { code: '' }]])('%s is unavailable', async (_name, params) => {
        const { jar, state } = started();
        expect(outcomeOf(await inert(await callback({ state, ...params }, jar)))).toBe('unavailable');
        expect(stub.exchangeCode).not.toHaveBeenCalled();
        expect(stub.bridge).not.toHaveBeenCalled();
    });
    it.each([
        ['a refused code exchange', () => stub.exchangeCode.mockRejectedValue(new Auth0Error('token_exchange_failed'))],
        ['a refused ID token (issuer, audience, nonce, expiry)', () => stub.verifyIdToken.mockRejectedValue(new Auth0Error('invalid_id_token'))],
        ['an unverified email', () => stub.verifyIdToken.mockRejectedValue(new Auth0Error('email_unverified'))],
        ['a session that could not be minted', () => stub.bridge.mockRejectedValue(new Auth0Error('session_failed'))],
        ['an unexpected error with private text', () => stub.bridge.mockRejectedValue(new Error('private-person@example.com'))],
    ])('%s is unavailable and keeps nothing', async (_name, arrange) => {
        const { jar, state } = started();
        arrange();
        lines = [];
        expect(outcomeOf(await inert(await callback({ state, code: 'private-code' }, jar)))).toBe('unavailable');
        expect(stub.retain).not.toHaveBeenCalled();
        expect(lines).toEqual([JSON.stringify({ event: 'ezil_assignment_work_auth', outcome: 'unavailable', attemptTag })]);
    });
});

describe('the callback answer: another account is never signed in', () => {
    it('🔴 a verified subject that does not own the assigned repository is account_mismatch, before the bridge', async () => {
        const { jar, state } = started();
        stub.verifyIdToken.mockResolvedValue({ sub: 'auth0|someone-else', email });
        lines = [];
        expect(outcomeOf(await inert(await callback({ state, code: 'private-code' }, jar)))).toBe('account_mismatch');
        expect(stub.refuseSwitch).not.toHaveBeenCalled();
        expect(stub.bridge).not.toHaveBeenCalled();
        expect(stub.retain).not.toHaveBeenCalled();
        expect(lines).toEqual([JSON.stringify({ event: 'ezil_assignment_work_auth', outcome: 'account_mismatch', attemptTag })]);
    });
    it('an owner tag that is not this subject\'s is account_mismatch too', async () => {
        const { jar, state } = started(query({ attempt, owner: '0'.repeat(16), request }));
        expect(outcomeOf(await inert(await callback({ state, code: 'private-code' }, jar)))).toBe('account_mismatch');
        expect(stub.bridge).not.toHaveBeenCalled();
    });
    it('🔴 an OS session for another account is left exactly as it is', async () => {
        const { jar, state } = started();
        stub.refuseSwitch.mockRejectedValue(new Auth0Error('account_conflict'));
        expect(outcomeOf(await inert(await callback({ state, code: 'private-code' }, jar)))).toBe('account_mismatch');
        expect(stub.bridge).not.toHaveBeenCalled();
        expect(stub.retain).not.toHaveBeenCalled();
        stub.refuseSwitch.mockRejectedValue(new Auth0Error('session_failed'));
        const again = started();
        expect(outcomeOf(await inert(await callback({ state: again.state, code: 'private-code' }, again.jar)))).toBe('unavailable');
        expect(stub.bridge).not.toHaveBeenCalled();
    });
});

describe('the callback answer: a lost, replayed or foreign transaction', () => {
    const untouched = () => { for (const call of [stub.exchangeCode, stub.verifyIdToken, stub.bridge, stub.retain]) expect(call).not.toHaveBeenCalled(); };
    it('🔴 a browser that kept no cookie gets the inert refusal at once, echoing only the request id', async () => {
        const { state } = started();
        lines = [];
        const html = await inert(await callback({ state, code: 'private-code' }, null));
        expect(outcomeOf(html)).toBe('unavailable');
        expect(html).toContain(`data-request="${request}"`);
        expect(html).not.toContain('data-attempt');
        untouched();
        expect(lines).toEqual([JSON.stringify({ event: 'ezil_assignment_work_auth', outcome: 'unavailable', attemptTag: null })]);
    });
    it('a tampered or re-signed cookie, an expired one, and another transaction\'s state are refused', async () => {
        const first = started(), second = started();
        const [payload, signature] = first.jar.slice(mine.length + 1).split('.') as [string, string];
        const forged = Buffer.from(JSON.stringify({ ...first.tx, owner: '0'.repeat(16) })).toString('base64url');
        for (const jar of [first.jar + 'x', `${mine}=${forged}.${signature}`, `${mine}=${payload}`,
            `${mine}=${payload}.${createHash('sha256').update(payload).digest('base64url')}`,
            // The right bytes under the unsuffixed name, or under another request's name, are not this transaction.
            `${WORK_AUTH_COOKIE}=${payload}.${signature}`, `${WORK_AUTH_COOKIE}-00000000-0000-4000-8000-000000000009=${payload}.${signature}`]) {
            expect(outcomeOf(await inert(await callback({ state: first.state, code: 'private-code' }, jar)))).toBe('unavailable');
        }
        expect(outcomeOf(await inert(await callback({ state: second.state, code: 'private-code' }, first.jar)))).toBe('unavailable');
        vi.useFakeTimers(); vi.setSystemTime(Date.now() + 120_001);
        expect(outcomeOf(await inert(await callback({ state: first.state, code: 'private-code' }, first.jar)))).toBe('unavailable');
        untouched();
    });
    it('🔴 two assignment tabs at once each keep their own transaction, in either order', async () => {
        const otherRequest = '00000000-0000-4000-8000-0000000000aa', otherAttempt = '00000000-0000-4000-8000-000000000001';
        const first = started();
        const second = started(query({ attempt: otherAttempt, owner, request: otherRequest }));
        expect(second.jar.startsWith(`${WORK_AUTH_COOKIE}-${otherRequest}=`)).toBe(true);
        // The browser holds both; the later start did not replace the earlier one.
        const both = first.jar + '; ' + second.jar;
        const late = await callback({ state: first.state, code: 'private-code' }, both);
        expect(late.headers.get('set-cookie')).toBe(mine + '=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax');
        const lateHtml = await late.text();
        expect(outcomeOf(lateHtml)).toBe('signed_in');
        expect(lateHtml).toContain(`data-attempt="${attempt}"`);
        const other = await callback({ state: second.state, code: 'private-code' }, both);
        expect(other.headers.get('set-cookie')).toBe(`${WORK_AUTH_COOKIE}-${otherRequest}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
        const otherHtml = await other.text();
        expect(outcomeOf(otherHtml)).toBe('signed_in');
        expect(otherHtml).toContain(`data-request="${otherRequest}"`);
        expect(otherHtml).toContain(`data-attempt="${otherAttempt}"`);
        // One tab's state never opens the other tab's cookie.
        const crossed = await callback({ state: first.state, code: 'private-code' }, second.jar);
        expect(outcomeOf(await crossed.text())).toBe('unavailable');
        expect(stub.bridge).toHaveBeenCalledTimes(2);
    });
    it('a replay after the answer cleared the cookie signs nobody in twice', async () => {
        const { jar, state } = started();
        const first = await callback({ state, code: 'private-code' }, jar);
        expect(first.headers.get('set-cookie')).toContain('Max-Age=0');
        expect(outcomeOf(await first.text())).toBe('signed_in');
        expect(outcomeOf(await inert(await callback({ state, code: 'private-code' }, null)))).toBe('unavailable');
        expect(stub.bridge).toHaveBeenCalledOnce();
    });
    it('the interactive sign-in\'s cookie is not a transaction here, and is neither read nor cleared', async () => {
        const { state } = started();
        const response = await callback({ state, code: 'private-code' }, AUTH0_COOKIE + '=interactive.value');
        expect(response.headers.get('set-cookie')).not.toContain(AUTH0_COOKIE);
        expect(outcomeOf(await inert(response))).toBe('unavailable');
        untouched();
    });
    it.each([['a malformed marked state', { state: 'ezw1.<script>alert(1)</script>' }], ['no state at all', {}], ['an interactive state', { state: 'A'.repeat(43) }]])(
        '%s in a frame is the same inert refusal, with nothing echoed', async (_name, params) => {
            const { jar } = started();
            const html = await inert(await callback({ ...params, code: 'private-code' }, jar));
            expect(outcomeOf(html)).toBe('unavailable');
            expect(html).not.toContain('data-request');
            expect(html).not.toContain('alert');
            untouched();
    });
    it('answers nothing at all away from the stage', async () => {
        const { jar, state } = started();
        const production = await callback({ state, code: 'private-code' }, jar, { 'sec-fetch-dest': 'iframe' }, 'https://os.ezil.work');
        expect(production.status).toBe(404);
        expect(production.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        stub.enabled.mockReturnValue(false);
        expect((await callback({ state, code: 'private-code' }, jar)).status).toBe(404);
        untouched();
    });
});

describe('which callbacks belong to this flow', () => {
    const at = (host: string, state: string | null, dest?: string) => isWorkAuthCallback(new Request(
        host + '/auth/auth0/callback?' + new URLSearchParams(state === null ? {} : { state }), { headers: dest ? { 'sec-fetch-dest': dest } : {} }));
    it('a marked state anywhere, and any framed callback on the stage; never an ordinary top-level one', () => {
        expect(at(os, started().state, 'iframe')).toBe(true);
        expect(at(os, 'ezw1.anything')).toBe(true);
        expect(at('https://os.ezil.work', 'ezw1.anything', 'document')).toBe(true);
        expect(at(os, 'A'.repeat(43), 'iframe')).toBe(true);
        expect(at(os, null, 'iframe')).toBe(true);
        expect(at(os, 'A'.repeat(43), 'document')).toBe(false);
        expect(at(os, 'A'.repeat(43))).toBe(false);
        expect(at('https://os.ezil.work', 'A'.repeat(43), 'iframe')).toBe(false);
        stub.enabled.mockReturnValue(false);
        expect(at(os, 'A'.repeat(43), 'iframe')).toBe(false);
    });
});

describe('the child document speaks only to its own OS parent under the Universe tab', () => {
    function run(build: (self: Record<string, unknown>, parent: Record<string, unknown>, top: Record<string, unknown>) => void, ancestors?: string[] | null) {
        const top: Record<string, unknown> = {}, parent: Record<string, unknown> = { postMessage: vi.fn() }, self: Record<string, unknown> = {};
        top.parent = top; top.top = top;
        self.location = ancestors === null ? {} : { ancestorOrigins: ancestors ?? [os, universe] };
        build(self, parent, top);
        new Function('window', 'document', WORK_AUTH_SCRIPT)(self, { body: { dataset: { outcome: 'signed_in', request, attempt } } });
        return parent.postMessage as ReturnType<typeof vi.fn>;
    }
    const exact = (self: Record<string, unknown>, parent: Record<string, unknown>, top: Record<string, unknown>) => { self.parent = parent; self.top = top; parent.parent = top; };
    it('posts one fixed-shape message to the exact OS origin', () => {
        for (const ancestors of [undefined, null]) {
            const post = run(exact, ancestors);
            expect(post).toHaveBeenCalledExactlyOnceWith({ protocol: 'ezil.assignment.work-auth/v1', request, attemptId: attempt, outcome: 'signed_in' }, os);
        }
    });
    it.each([
        ['opened top-level', (self: Record<string, unknown>) => { self.parent = self; self.top = self; }, undefined],
        ['a direct child of the top document', (self: Record<string, unknown>, parent: Record<string, unknown>) => { self.parent = parent; self.top = parent; parent.parent = parent; }, undefined],
        ['nested one level deeper', (self: Record<string, unknown>, parent: Record<string, unknown>, top: Record<string, unknown>) => { self.parent = parent; self.top = top; parent.parent = { parent: top }; }, undefined],
        ['under another top-level site', exact, [os, 'https://elsewhere.example']],
        ['under another parent origin', exact, [universe, universe]],
        ['under a longer ancestor chain', exact, [os, universe, universe]],
    ] as const)('stays silent when %s', (_name, build, ancestors) => {
        expect(run(build as never, ancestors as string[] | undefined)).not.toHaveBeenCalled();
    });
});

describe('production: the same flow on os.ezil.work inside universe.ezil.work, and nowhere else', () => {
    beforeEach(() => { productionEnv(); });
    const unowned = ['https://os-prod.ezil.work', 'https://os.ezil.org', 'https://evil.example', os];
    it('starts only on the production OS origin and returns to its own registered callback', () => {
        const response = begin(query(), frame, prodOs);
        expect(response.status).toBe(303);
        const authorize = new URL(response.headers.get('location')!);
        expect(authorize.origin + authorize.pathname).toBe('https://id.ezil.work/authorize');
        expect(authorize.searchParams.get('redirect_uri')).toBe(prodOs + '/auth/auth0/callback');
        expect(authorize.searchParams.get('prompt')).toBe('none');
        expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
        expect(response.headers.get('set-cookie')).toMatch(new RegExp('^' + mine + '=[\\w.-]+; Path=/; Max-Age=120; HttpOnly; Secure; SameSite=Lax$'));
        // The staging host, the landing site, a sibling and an unowned host are not this deployment: never the
        // canonical fallback, and never a transaction.
        for (const host of unowned) {
            const refusal = begin(query(), frame, host);
            expect(refusal.status).toBe(404);
            expect(refusal.headers.get('set-cookie')).toBeNull();
        }
        const others: Record<string, string>[] = [{ 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-site' },
            { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'cross-site' }, {}];
        for (const headers of others) expect(begin(query(), headers, prodOs).status).toBe(404);
    });
    it('🔴 mints a session only for the verified owner, and frames its answer only by the production pair', async () => {
        const response0 = begin(query(), frame, prodOs);
        const jar = response0.headers.get('set-cookie')!.split(';')[0]!;
        const state = new URL(response0.headers.get('location')!).searchParams.get('state')!;
        const tx = JSON.parse(Buffer.from(jar.slice(jar.indexOf('=') + 1).split('.')[0]!, 'base64url').toString());
        const response = await callback({ state, code: 'private-code' }, jar, { 'sec-fetch-dest': 'iframe' }, prodOs);
        const policy = response.headers.get('content-security-policy')!;
        const html = await inert(response);
        expect(outcomeOf(html)).toBe('signed_in');
        expect(stub.exchangeCode).toHaveBeenCalledWith('private-code', { origin: prodOs, codeVerifier: tx.codeVerifier });
        const script = inlineScript(html);
        expect(script).toBe(workAuthScript({ os: prodOs, universe: prodUniverse }));
        expect(script).not.toContain('staging');
        expect(policy).toBe(`default-src 'none'; script-src 'sha256-${createHash('sha256').update(script).digest('base64')}'; base-uri 'none'; form-action 'none'; frame-ancestors ${prodOs} ${prodUniverse}`);
        // Another verified account is never signed in, on production as on staging.
        stub.bridge.mockClear();
        const again = begin(query(), frame, prodOs);
        const jar2 = again.headers.get('set-cookie')!.split(';')[0]!;
        stub.verifyIdToken.mockResolvedValue({ sub: 'auth0|someone-else', email });
        const other = await callback({ state: new URL(again.headers.get('location')!).searchParams.get('state')!, code: 'private-code' }, jar2, { 'sec-fetch-dest': 'iframe' }, prodOs);
        expect(outcomeOf(await inert(other))).toBe('account_mismatch');
        expect(stub.bridge).not.toHaveBeenCalled();
    });
    it('answers a production transaction nowhere but on the production OS origin', async () => {
        const response0 = begin(query(), frame, prodOs);
        const jar = response0.headers.get('set-cookie')!.split(';')[0]!;
        const state = new URL(response0.headers.get('location')!).searchParams.get('state')!;
        for (const host of unowned) {
            const refusal = await callback({ state, code: 'private-code' }, jar, { 'sec-fetch-dest': 'iframe' }, host);
            expect(refusal.status).toBe(404);
            expect(refusal.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
        }
        expect(stub.exchangeCode).not.toHaveBeenCalled();
        expect(stub.bridge).not.toHaveBeenCalled();
        const at = (host: string, dest?: string) => isWorkAuthCallback(new Request(host + '/auth/auth0/callback?state=' + 'A'.repeat(43), { headers: dest ? { 'sec-fetch-dest': dest } : {} }));
        expect(at(prodOs, 'iframe')).toBe(true);
        expect(at(prodOs, 'document')).toBe(false);
        for (const host of unowned) expect(at(host, 'iframe')).toBe(false);
    });
    it('is off without the selected production deployment: no authority, no flow', () => {
        vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED', '');
        expect(begin(query(), frame, prodOs).status).toBe(404);
        productionEnv(); vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN', universe);
        expect(begin(query(), frame, prodOs).status).toBe(404);
        productionEnv(); stub.enabled.mockReturnValue(false);
        expect(begin(query(), frame, prodOs).status).toBe(404);
    });
    it('the production child speaks only to os.ezil.work under universe.ezil.work', () => {
        const run = (ancestors: string[]) => {
            const top: Record<string, unknown> = {}, parent: Record<string, unknown> = { postMessage: vi.fn(), parent: top }, self: Record<string, unknown> = { parent, top, location: { ancestorOrigins: ancestors } };
            top.parent = top; top.top = top;
            new Function('window', 'document', workAuthScript({ os: prodOs, universe: prodUniverse }))(self, { body: { dataset: { outcome: 'signed_in', request, attempt } } });
            return parent.postMessage as ReturnType<typeof vi.fn>;
        };
        expect(run([prodOs, prodUniverse])).toHaveBeenCalledExactlyOnceWith({ protocol: 'ezil.assignment.work-auth/v1', request, attemptId: attempt, outcome: 'signed_in' }, prodOs);
        for (const ancestors of [[os, universe], [prodOs, universe], [os, prodUniverse], [prodOs, 'https://elsewhere.example'], [prodUniverse, prodUniverse]])
            expect(run(ancestors)).not.toHaveBeenCalled();
    });
});
