import 'server-only';
import { cookies } from 'next/headers';
import { createClient } from '@/utils/supabase/server';
import { verifyProjectIdToken } from '@/server/auth/auth0';
import { Vault } from './vault';
import { validateRedemption, type RetainedIdentity, type PrivateGrant } from './contract';
export const IDENTITY_COOKIE = '__Host-ezil-project-identity';
export const LAUNCH_COOKIE = '__Host-ezil-project-launch';
export const COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
interface Launch { code?: string; deadline: number; userId?: string; sessionId?: string; computerId?: string; grant?: PrivateGrant; busy?: boolean }
const state = globalThis as typeof globalThis & { ezilProjectVault?: { identities: Vault<RetainedIdentity>; launches: Vault<Launch> } };
export const vaults = state.ezilProjectVault ??= { identities: new Vault(), launches: new Vault() };
async function currentSession(userId?: string) {
    const client = await createClient();
    const { data, error } = await client.auth.getClaims();
    const c = data?.claims;
    if (error || !c || typeof c.sub !== 'string' || typeof c.session_id !== 'string' || (userId && c.sub !== userId)) throw new Error('project_repo_invalid_identity');
    return { userId: c.sub, sessionId: c.session_id };
}
export async function retainProjectIdentity(token: string) {
    const verified = await verifyProjectIdToken(token);
    const session = await currentSession();
    const jar = await cookies();
    vaults.identities.delete(jar.get(IDENTITY_COOKIE)?.value);
    const handle = vaults.identities.put({ token, ...verified, ...session }, verified.expiresAt);
    jar.set(IDENTITY_COOKIE, handle, { ...COOKIE_OPTIONS, expires: new Date(verified.expiresAt) });
}
export async function retainedIdentity(userId?: string) {
    const session = await currentSession(userId);
    const record = vaults.identities.get((await cookies()).get(IDENTITY_COOKIE)?.value);
    if (!record || record.userId !== session.userId || record.sessionId !== session.sessionId) throw new Error('project_repo_invalid_identity');
    const checked = await verifyProjectIdToken(record.token).catch(() => { throw new Error('project_repo_invalid_identity'); });
    if (checked.subject !== record.subject || checked.issuer !== record.issuer) throw new Error('project_repo_invalid_identity');
    return record;
}
export async function clearProjectIdentity() {
    const jar = await cookies();
    vaults.identities.delete(jar.get(IDENTITY_COOKIE)?.value); vaults.launches.delete(jar.get(LAUNCH_COOKIE)?.value);
    jar.set(IDENTITY_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 }); jar.set(LAUNCH_COOKIE, '', { ...COOKIE_OPTIONS, maxAge: 0 });
}
export async function launchGrant(userId: string, computerId: string): Promise<PrivateGrant | undefined> {
    const handle = (await cookies()).get(LAUNCH_COOKIE)?.value;
    if (!handle) return;
    const entry = vaults.launches.get(handle);
    if (!entry || entry.busy) throw new Error('project_repo_not_authorized');
    const identity = await retainedIdentity(userId);
    if (entry.grant) {
        if (entry.userId !== userId || entry.sessionId !== identity.sessionId || entry.computerId !== computerId) throw new Error('project_repo_not_authorized');
        validateRedemption({ binding: entry.grant.binding, identity: entry.grant.identity, git: entry.grant.git }, identity);
        return entry.grant;
    }
    if (!entry.code || entry.deadline <= Date.now()) throw new Error('project_repo_not_authorized');
    const base = process.env.PROJECT_REPO_WORKS_ORIGIN;
    let origin: URL;
    try { origin = new URL(base!); if (origin.protocol !== 'https:' || origin.origin !== base || origin.username || origin.password) throw new Error(); }
    catch { throw new Error('project_repo_configuration_required'); }
    entry.busy = true;
    const code = entry.code; delete entry.code; // never retry a possibly consumed code
    try {
        const response = await fetch(new URL('/internal/project-repositories/redeem', origin), {
            method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000),
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userIdToken: identity.token, code }),
        });
        const raw = await response.text();
        if (!response.ok) {
            let code = ''; try { if (raw.length <= 16384) code = JSON.parse(raw).error; } catch { /* no raw output */ }
            throw new Error(['project_repo_configuration_required','project_repo_identity_unavailable','project_repo_invalid_identity'].includes(code) ? code : 'project_repo_not_authorized');
        }
 if (raw.length > 16384) throw new Error('project_repo_not_authorized');
        const grant = { version: 1 as const, ...validateRedemption(JSON.parse(raw), identity) };
        Object.assign(entry, { userId, sessionId: identity.sessionId, computerId, grant });
        vaults.launches.expire(handle, Date.parse(grant.git.expiresAt));
        return grant;
    } catch (error) {
        if (error instanceof Error && ['project_repo_configuration_required','project_repo_identity_unavailable','project_repo_invalid_identity'].includes(error.message)) throw error;
        throw new Error('project_repo_not_authorized');
    }
    finally { entry.busy = false; }
}
