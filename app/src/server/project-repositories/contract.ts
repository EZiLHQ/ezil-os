import { z } from 'zod';
import { canonicalRepository } from '@/server/lib/compute/repo-open';
export const launchCode = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const binding = z.object({ projectId: z.string().uuid(), repositoryId: z.string().uuid(),
    canonicalURL: z.string().regex(canonicalRepository), bindingVersion: z.string().regex(/^[a-f0-9]{64}$/),
    ref: z.string().max(255).regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/).refine(ref => !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/')
        && ref.split('/').every(p => !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'))),
}).strict();
export const redemption = z.object({ binding,
    identity: z.object({ issuer: z.literal('https://id.ezil.work/'), subject: z.string().min(1).max(255) }).strict(),
    git: z.object({ username: z.literal('ezil'), token: z.string().max(8192).regex(/^egg_[A-Za-z0-9._~-]+$/),
        expiresAt: z.string().datetime(), scope: z.literal('read') }).strict(),
}).strict();
export type Redemption = z.infer<typeof redemption>;
export type PrivateGrant = Redemption & { version: 1 };
export interface RetainedIdentity { token: string; issuer: string; subject: string; expiresAt: number; userId: string; sessionId: string }
export function validateRedemption(value: unknown, identity: RetainedIdentity, now = Date.now()): Redemption {
    const parsed = redemption.parse(value);
    const expiry = Date.parse(parsed.git.expiresAt);
    if (parsed.identity.issuer !== identity.issuer || parsed.identity.subject !== identity.subject
        || expiry <= now || expiry > now + 300000 || expiry > identity.expiresAt || identity.expiresAt <= now) throw new Error('project_repo_not_authorized');
    return parsed;
}
export function trustedOrigin(value: string | null, configured: string | undefined): boolean {
    if (!value || !configured) return false;
    return configured.split(',').some(entry => {
        try { const u = new URL(entry.trim()); return u.protocol === 'https:' && !u.username && !u.password && u.origin === entry.trim() && value === u.origin; }
        catch { return false; }
    });
}
