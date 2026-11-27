import 'server-only';

import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

import { assignmentAuthority } from '@/server/assignment-video/authority';
import { assignmentStageTag } from '@/server/assignment-video/stage-tag';
import { assignmentEnrollmentEnabled, ownerRepositoryName } from '@/server/git/assignment-enrollment';
import { workAuthPath, workAuthProtocol, workAuthQuery, workAuthStatePrefix, type WorkAuthOutcome } from '@/utils/assignment-work-silent';
import { publicOrigin } from '@/utils/forwarded';

import { Auth0Error, auth0Enabled, exchangeCode, SILENT_LOGIN_FALLBACK_ERRORS, verifyIdToken } from './auth0';
import { bridgeAuth0Identity, refuseSilentAccountSwitch } from './bridge';
import { AUTH0_ISSUER } from './issuer';
import { retainProjectIdentity } from './retained-identity';

/**
 * The silent sign-in of a cold EZiL OS frame inside its own Universe assignment tab. OS and Universe are one selected
 * deployment (`@/server/assignment-video/authority`): production pairs only with production, staging with staging.
 *
 * The visible OS frame (`/app/code` for one assigned repository, framed by Universe) has no OS session. Once Universe
 * has asked it, it inserts ONE hidden same-origin child at `workAuthPath`. That child goes to id.ezil.work with
 * `prompt=none` and comes back to the ordinary registered callback, which hands every such answer to `settleWorkAuth`.
 * The top-level Universe document, and so its screen capture, never navigates.
 *
 * What makes this narrow:
 * - Started only by an OS document (`Sec-Fetch-Site: same-origin`) as a frame (`Sec-Fetch-Dest: iframe`), on the
 *   selected deployment's own OS origin exactly as the request named it (never a fallback host), for an exact
 *   `attempt` / `owner` / `request` query. Anything else is a 404.
 * - Its own transaction (state, nonce, S256 PKCE verifier, 2 minutes) in its own signed host-only cookie, named for
 *   the request id, so two assignment tabs never overwrite each other's. The interactive sign-in's
 *   `__Host-ezil-auth0` is never read, written or cleared here.
 * - `prompt=none` only. The answer is ALWAYS the inert document below: no redirect, no lock screen, no interactive
 *   id.ezil.work page, whatever arrived (a lost cookie, a replayed or foreign state, a provider error).
 * - A session is minted only after the ID token is verified (issuer, audience, nonce, expiry, verified email), its
 *   subject derives the owner tag of the assigned repository, and any existing OS session is that same account.
 * - The child tells its parent one word from a fixed list. No token, code, subject, email or URL is put in the page,
 *   a message or a log line.
 */
export const WORK_AUTH_COOKIE = '__Host-ezil-work-auth';
/** One cookie per request id (`<name>-<uuid>`): at most one per assignment per tab, each gone within two minutes. */
const cookieName = (request: string) => `${WORK_AUTH_COOKIE}-${request}`;
const stateRequest = /^ezw1\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[\w-]{43}$/;
const TTL_MS = 120_000;
const closed = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
const refused = () => new Response(null, { status: 404, headers: { ...closed, 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' } });
const cookie = (request: string, value: string, maxAge: number) => `${cookieName(request)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

interface Transaction { state: string; nonce: string; codeVerifier: string; attempt: string; owner: string; request: string; expiresAt: number }

/** One line per start and per answer: a fixed event, a fixed outcome and the tag. Never anything from the request. */
function record(outcome: 'started' | WorkAuthOutcome, attempt: string | null): void {
    console.info(JSON.stringify({ event: 'ezil_assignment_work_auth', outcome, attemptTag: attempt === null ? null : assignmentStageTag(attempt) }));
}

function sign(payload: string): string {
    // Domain-separated from the interactive transaction's key; the client secret is never an HMAC key itself.
    const key = hkdfSync('sha256', process.env.AUTH0_SECRET_ID!, AUTH0_ISSUER, 'ezil/auth0/work-auth/v1', 32);
    return createHmac('sha256', Buffer.from(key)).update(payload).digest('base64url');
}
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); };
type Authority = NonNullable<ReturnType<typeof assignmentAuthority>>;
/**
 * The selected deployment, only for a request made to its own OS origin. `publicOrigin`, not `ownedPublicOrigin`: an
 * unowned host must never be read as the canonical production origin here.
 */
function deployment(request: Request): Authority | null {
    const authority = assignmentAuthority();
    return authority && auth0Enabled() && assignmentEnrollmentEnabled() && publicOrigin(request.headers, request.url) === authority.os
        ? authority : null;
}

/** `GET /assignment/work-auth?attempt=&owner=&request=` — the hidden child's first and only own request. */
export function startWorkAuth(request: Request): Response {
    const query = workAuthQuery(new URL(request.url).searchParams);
    const authority = deployment(request);
    if (!query || new URL(request.url).pathname !== workAuthPath || !authority
        || request.headers.get('sec-fetch-dest') !== 'iframe' || request.headers.get('sec-fetch-site') !== 'same-origin') return refused();
    const transaction: Transaction = {
        state: workAuthStatePrefix + query.request + '.' + randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'), codeVerifier: randomBytes(32).toString('base64url'),
        attempt: query.attempt, owner: query.owner, request: query.request, expiresAt: Date.now() + TTL_MS,
    };
    const payload = Buffer.from(JSON.stringify(transaction)).toString('base64url');
    const authorize = new URL('authorize', AUTH0_ISSUER);
    authorize.search = new URLSearchParams({
        client_id: process.env.AUTH0_CLIENT_ID!, response_type: 'code', scope: 'openid email profile',
        redirect_uri: authority.os + '/auth/auth0/callback', state: transaction.state, nonce: transaction.nonce,
        code_challenge: createHash('sha256').update(transaction.codeVerifier).digest('base64url'), code_challenge_method: 'S256',
        prompt: 'none',
    }).toString();
    record('started', query.attempt);
    // A bare redirect: no framing header rides on it, so no browser can read one as a refusal of the hop itself.
    return new Response(null, { status: 303, headers: { ...closed, Location: authorize.href,
        'Set-Cookie': cookie(query.request, `${payload}.${sign(payload)}`, TTL_MS / 1000) } });
}

/** A callback that belongs to this flow, or that arrived in a frame on this deployment's OS origin: it never takes the interactive path. */
export function isWorkAuthCallback(request: Request): boolean {
    return (new URL(request.url).searchParams.get('state') ?? '').startsWith(workAuthStatePrefix)
        || (request.headers.get('sec-fetch-dest') === 'iframe' && deployment(request) !== null);
}

function readTransaction(request: Request, state: string | null): Transaction | null {
    // The state names its own cookie; a state of any other shape has none.
    const name = cookieName(stateRequest.exec(state ?? '')?.[1] ?? '') + '=';
    const value = (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).find(part => part.startsWith(name))?.slice(name.length);
    if (!value || value.length > 4096 || !state) return null;
    const parts = value.split('.');
    if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]!) || !same(sign(parts[0]!), parts[1]!)) return null;
    let tx: Transaction;
    try { tx = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')); } catch { return null; }
    const now = Date.now();
    if (!tx || !Number.isFinite(tx.expiresAt) || tx.expiresAt <= now || tx.expiresAt > now + TTL_MS
        || ![tx.nonce, tx.codeVerifier].every(part => typeof part === 'string' && /^[\w-]{43}$/.test(part))
        || typeof tx.state !== 'string' || !workAuthQuery(new URLSearchParams({ attempt: tx.attempt, owner: tx.owner, request: tx.request }))
        || !tx.state.startsWith(workAuthStatePrefix + tx.request + '.') || !same(tx.state, state)) return null;
    return tx;
}

/**
 * The child's whole script. It speaks only when this document is exactly the grandchild of the Universe tab and the
 * child of an OS document, and only to that OS origin. Fixed text, so the policy can pin its hash.
 */
export const workAuthScript = ({ os, universe }: Pick<Authority, 'os' | 'universe'>) =>
    `(function(){var w=window,d=document.body.dataset,a=w.location.ancestorOrigins,os=${JSON.stringify(os)};`
    + `if(w.parent===w||w.parent.parent!==w.top||w.parent.parent===w.parent)return;`
    + `if(a&&(a.length!==2||a[0]!==os||a[1]!==${JSON.stringify(universe)}))return;`
    + `w.parent.postMessage({protocol:${JSON.stringify(workAuthProtocol)},request:d.request||null,attemptId:d.attempt||null,outcome:d.outcome},os);})();`;
/** Only this deployment's OS origin, inside its paired Universe, may frame the answer; only its own script may run. */
const policy = (authority: Authority) =>
    `default-src 'none'; script-src 'sha256-${createHash('sha256').update(workAuthScript(authority)).digest('base64')}'; base-uri 'none'; form-action 'none'; `
    + `frame-ancestors ${authority.os} ${authority.universe}`;

/**
 * `echo`: with no transaction to vouch for it (a browser that kept no cookie), the request id is read back from the
 * shape of the state alone. It lets the parent stop waiting at once, and only ever beside a refusal.
 */
function settled(authority: Authority, outcome: WorkAuthOutcome, tx: Transaction | null, echo?: string | null): Response {
    record(outcome, tx?.attempt ?? null);
    // Only values this server generated or validated against fixed shapes reach the page.
    const request = tx?.request ?? (outcome === 'unavailable' ? stateRequest.exec(echo ?? '')?.[1] : undefined);
    const data = `data-outcome="${outcome}"` + (request ? ` data-request="${request}"` : '') + (tx ? ` data-attempt="${tx.attempt}"` : '');
    // Spent: this request's own cookie only. A state that names none leaves every cookie as it was.
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>EZiL OS</title></head><body ${data}><script>${workAuthScript(authority)}</script></body></html>`,
        { status: 200, headers: { ...closed, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': policy(authority),
            ...(request ? { 'Set-Cookie': cookie(request, '', 0) } : {}) } });
}

/** The callback's answer for this flow. Never throws, never redirects. */
export async function settleWorkAuth(request: Request): Promise<Response> {
    const authority = deployment(request);
    if (!authority) return refused();
    const params = new URL(request.url).searchParams;
    const tx = readTransaction(request, params.get('state'));
    if (!tx) return settled(authority, 'unavailable', null, params.get('state'));
    const error = params.get('error'), code = params.get('code');
    if (error !== null) return settled(authority, SILENT_LOGIN_FALLBACK_ERRORS.has(error) ? 'sign_in_required' : 'unavailable', tx);
    if (!code) return settled(authority, 'unavailable', tx);
    try {
        const token = await exchangeCode(code, { origin: authority.os, codeVerifier: tx.codeVerifier });
        const identity = await verifyIdToken(token, { nonce: tx.nonce });
        // Before any session exists: the verified person must own the repository this frame was assigned …
        if (ownerRepositoryName(identity.sub, 'a-' + tx.attempt) !== `u-${tx.owner}-a-${tx.attempt}`) return settled(authority, 'account_mismatch', tx);
        // … and an OS session already in this browser must be that same account. Never a silent switch.
        try { await refuseSilentAccountSwitch(identity); } catch (refusal) {
            return settled(authority, refusal instanceof Auth0Error && refusal.code === 'account_conflict' ? 'account_mismatch' : 'unavailable', tx);
        }
        await bridgeAuth0Identity(identity);
        try { await retainProjectIdentity(token); } catch { console.warn('[auth0] identity not retained'); }
        return settled(authority, 'signed_in', tx);
    } catch {
        return settled(authority, 'unavailable', tx);
    }
}
