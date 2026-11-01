import 'server-only';

import { cookies } from 'next/headers';

import { createClient } from '@/utils/supabase/server';

import { AUTH0_COOKIE_OPTIONS, verifyProjectIdToken } from './auth0';
import { Vault } from './vault';

/**
 * The person's verified EZiL ID token, kept on the server for the one thing that needs it: asking Universe 2.0 for a
 * project repository (`../works/project-repo.ts`). Ported from the identity part of 1ac89c72.
 *
 * - The token lives only in this process's memory. The browser holds a random handle in an httpOnly cookie, never the
 *   token, and the vault entry is bound to the Supabase user AND session that signed in with it.
 * - It is retained by the Auth0 callback, after `bridgeAuth0Identity` has minted the session it is bound to, and
 *   deleted at sign-out.
 * - A miss (a restart, another replica, an expired or foreign entry) is `IdentityRefreshRequired`. The shell answers
 *   it with one `prompt=none` round trip through `/auth/auth0/login`, which retains a fresh token.
 */
export const IDENTITY_COOKIE = '__Host-ezil-project-identity';

/** A token this close to expiry is refreshed first: Universe caps the Git token at the ID token's own expiry. */
export const IDENTITY_MIN_VALIDITY_MS = 60_000;

export interface RetainedIdentity { token: string; issuer: string; subject: string; expiresAt: number; userId: string; sessionId: string }

export class IdentityRefreshRequired extends Error {
    constructor() { super('IDENTITY_REFRESH_REQUIRED'); }
}

const state = globalThis as typeof globalThis & { ezilRetainedIdentities?: Vault<RetainedIdentity> };
export const identities = state.ezilRetainedIdentities ??= new Vault<RetainedIdentity>();

async function currentSession(userId?: string) {
    const { data, error } = await (await createClient()).auth.getClaims();
    const c = data?.claims;
    if (error || !c || typeof c.sub !== 'string' || typeof c.session_id !== 'string' || !c.session_id
        || (userId !== undefined && c.sub !== userId)) throw new IdentityRefreshRequired();
    return { userId: c.sub, sessionId: c.session_id };
}

/** Called by the Auth0 callback with the token `verifyIdToken` just accepted. Replaces any earlier entry. */
export async function retainProjectIdentity(token: string): Promise<void> {
    const verified = await verifyProjectIdToken(token);
    const session = await currentSession();
    const jar = await cookies();
    identities.delete(jar.get(IDENTITY_COOKIE)?.value);
    const handle = identities.put({ token, ...verified, ...session }, verified.expiresAt);
    jar.set(IDENTITY_COOKIE, handle, { ...AUTH0_COOKIE_OPTIONS, expires: new Date(verified.expiresAt) });
}

/** The retained identity for `userId`'s current session, re-verified, or `IdentityRefreshRequired`. */
export async function retainedIdentity(userId: string, now = Date.now): Promise<RetainedIdentity> {
    const session = await currentSession(userId);
    const record = identities.get((await cookies()).get(IDENTITY_COOKIE)?.value);
    if (!record || record.userId !== session.userId || record.sessionId !== session.sessionId
        || record.expiresAt - now() < IDENTITY_MIN_VALIDITY_MS) throw new IdentityRefreshRequired();
    const checked = await verifyProjectIdToken(record.token).catch(() => { throw new IdentityRefreshRequired(); });
    if (checked.subject !== record.subject || checked.issuer !== record.issuer) throw new IdentityRefreshRequired();
    return record;
}

/** Sign-out, or Universe refusing the token: the next project open must refresh it. */
export async function clearProjectIdentity(): Promise<void> {
    const jar = await cookies();
    identities.delete(jar.get(IDENTITY_COOKIE)?.value);
    jar.set(IDENTITY_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
}
