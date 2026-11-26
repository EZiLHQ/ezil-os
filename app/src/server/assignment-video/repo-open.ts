import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { assignmentMarker } from '@/server/git/assignment-bootstrap';
import { expectedRepositoryURL } from '@/server/git/assignment-enrollment';
import type { PreloadChallenge } from '@/server/lib/compute/repo-open';
import type { PrivateGitPacket } from '@/server/git/private-packet';
import { eligible, issuer, refuse, uuid, validAssignmentWindow } from './contract';
import { workspaceIdentity } from './workspace-identity';

export { workspaceIdentity } from './workspace-identity';

type Actor = Pick<RetainedIdentity, 'userId'|'issuer'|'subject'|'sessionId'|'expiresAt'>;
const lifetime = 5 * 60_000;
const timestamp = z.string().datetime({offset: true});
const boundRepo = {
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), repositoryUrl: z.string().max(260), providerId: z.string().regex(/^[a-z0-9]{1,64}$/),
    ref: z.literal('refs/heads/main'),
};
type Eligible = z.infer<typeof eligible>;
const event = z.object({...boundRepo, preloadProtocol:z.literal('ezil.assignment-open/v1'), preloadPort:z.literal(5679), eventId: uuid, workspaceId: z.string().regex(/^[a-f0-9]{64}$/), openedAt: timestamp}).strict();
const receipt = z.object({event, attemptId: uuid, expires: z.number().int(), actor: z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export { assignmentSigningSecret as repoOpenSecret } from './authority';

export function enrolledAttempt(actor: Actor, packet: PrivateGitPacket, now: number): string | undefined {
    if (actor.issuer !== issuer || !actor.sessionId || !actor.userId || actor.expiresAt <= now || packet.identity.issuer !== issuer
        || packet.identity.subject !== actor.subject || packet.git.scope !== 'write' || packet.repository.ref !== 'refs/heads/main') return;
    const attemptId = packet.repository.canonicalURL.match(/-a-([0-9a-f-]{36})\.git$/)?.[1];
    if (uuid.safeParse(attemptId).success && packet.repository.canonicalURL === expectedRepositoryURL(actor.subject, 'a-' + attemptId))
        return attemptId;
}

export function makeChallenge(attemptId: string, repositoryUrl: string): PreloadChallenge {
    return {eventId: randomUUID(), attemptId, nonce: randomBytes(32).toString('hex'),
        manifestSha256: createHash('sha256').update(assignmentMarker(repositoryUrl)).digest('hex')};
}

export function eligibleForActor(eligible: Eligible, actor: Actor, attemptId: string, now: number): boolean {
    const original = eligible.windowStartedAt && Date.parse(eligible.windowStartedAt);
    const end = eligible.deadlineAt && Date.parse(eligible.deadlineAt);
    const pause = eligible.pausedAt ? Date.parse(eligible.pausedAt) : null;
    return eligible.attemptId === attemptId && eligible.repositoryUrl === expectedRepositoryURL(actor.subject, 'a-' + attemptId)
        && eligible.manifestSha256 === createHash('sha256').update(assignmentMarker(eligible.repositoryUrl)).digest('hex')
        && now < Date.parse(eligible.expiresAt)
        && ((original === null && end === null && pause === null) || (typeof original === 'number' && typeof end === 'number'
            && original <= now && validAssignmentWindow(original, end, eligible.revision)
            && (pause === null ? now < end : (eligible.revision ?? 0) > 0 && original <= pause && pause <= now && pause < end)));
}

export function matchesEnrollment(eligible: Eligible, packet: PrivateGitPacket, attemptId: string, now: number) {
    return eligible.attemptId === attemptId && eligible.repositoryUrl === packet.repository.canonicalURL
        && eligible.providerId === packet.repository.id && eligible.ref === packet.repository.ref
        && !eligible.pausedAt && (eligible.deadlineAt === null || now < Date.parse(eligible.deadlineAt)) && now < Date.parse(eligible.expiresAt);
}

const actorBinding = (actor: Actor) => createHash('sha256').update(JSON.stringify(
    [actor.userId, actor.issuer, actor.subject, actor.sessionId])).digest('hex');
const encryptionKey = (secret: string) => createHmac('sha256', secret).update('ezil/assignment-repo-open/encryption/v1').digest();

// A short-lived opaque proof travels solely in same-origin shell memory. No Git grant, user token or actor identifier is stored in it.
export function sealOpen(actor: Actor, eligible: Eligible, computerId: string, workspace: string, eventId: string, now: number, secret: string) {
    const openedAt = new Date(now).toISOString();
    const workspaceId = workspaceIdentity(actor.userId, computerId, workspace);
    const data = {event: {eventId, preloadProtocol:'ezil.assignment-open/v1', preloadPort:5679, manifestSha256: eligible.manifestSha256, repositoryUrl: eligible.repositoryUrl, providerId: eligible.providerId, ref: eligible.ref,
        workspaceId, openedAt}, attemptId: eligible.attemptId, expires: Math.min(now + lifetime, Date.parse(eligible.expiresAt), eligible.deadlineAt ? Date.parse(eligible.deadlineAt) : Infinity),
        actor: actorBinding(actor)};
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    const proof = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    return {attemptId: eligible.attemptId, proof, openedAt, windowStartedAt: eligible.windowStartedAt, deadlineAt: eligible.deadlineAt};
}

// Reopening the already-authorized editor may occur after the short opening proof expires. Only `active-reopen` skips
// that expiry, and its one caller must independently verify the exact active capture and original receipt event id
// (and re-bind the manifest, repository, provider and workspace) before using the decoded event. Every other reader
// (`open`, `prepare`, the broker's `begin` and `editor-ready`) stays fresh.
export function readOpen(proof: string, actor: Actor, attemptId: string, now: number, secret: string,
    purpose: 'fresh' | 'active-reopen' = 'fresh') {
    try {
        const raw = Buffer.from(proof, 'base64url');
        if (raw.toString('base64url') !== proof || raw.length < 32 || raw.length > 1210) throw Error();
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), raw.subarray(0,12));
        decipher.setAuthTag(raw.subarray(12,28));
        const data = receipt.parse(JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)),decipher.final()]).toString('utf8')));
        if (data.attemptId === attemptId && data.actor === actorBinding(actor) && (purpose === 'active-reopen' || data.expires > now)
            && Date.parse(data.event.openedAt) <= now && data.event.repositoryUrl === expectedRepositoryURL(actor.subject, 'a-' + attemptId)) return data.event;
    } catch { /* A foreign, altered or expired proof has the same refusal. */ }
    return refuse('assignment_open_required', 409);
}

export function signRepoOpen(secret: string, action: 'begin' | 'editor-ready', body: string, now: number): Record<string,string> {
    const time = String(now);
    return {'X-Ezil-Repo-Open-Timestamp':time,
        'X-Ezil-Repo-Open-Signature':createHmac('sha256',secret)
            .update(time + '.POST /internal/assignment-video/' + action + '.' + body).digest('hex')};
}
