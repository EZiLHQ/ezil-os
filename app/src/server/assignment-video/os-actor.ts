import 'server-only';

import { createHmac, randomUUID } from 'node:crypto';
import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { expectedRepositoryURL } from '@/server/git/assignment-repository-name';
import { assignmentAuthority, productionAssignment, assignmentSigningSecret } from './authority';

const domain = 'ezil.universe.assignment.os-actor.v1';
const issuer = 'https://id.ezil.work/';
const origin = productionAssignment.universe;
const enrollment = '/internal/assignment-repositories/enrollment';
const media = '/internal/assignment-video/';
const paths = new Set([enrollment, ...['preflight','begin','status','checkpoint','finalize'].map(action => media + action)]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Add an OS service credential only to a server-constructed request for the current participant. */
export function osActorHeaders(identity: RetainedIdentity, endpoint: string, attemptId: string, serialized: string,
    now: number = Date.now(), env: Record<string, string | undefined> = process.env): Record<string,string> {
    const secret = assignmentSigningSecret(env);
    const path = endpoint.slice(origin.length);
    if (assignmentAuthority(env) !== productionAssignment || !secret || !endpoint.startsWith(origin)
        || !paths.has(path) || !uuid.test(attemptId) || !/^[0-9]{13}$/.test(String(now)) ||
        identity.issuer !== issuer || !identity.sessionId || !identity.userId || !identity.token ||
        !Number.isFinite(identity.expiresAt) || identity.expiresAt <= now || !/^[\x21-\x7e]{1,255}$/.test(identity.subject)) {
        throw new Error('Assignment OS actor proof unavailable');
    }
    const body = JSON.parse(serialized);
    if (!body || body.attemptId !== attemptId || body.userIdToken !== identity.token ||
        (path !== enrollment && body.osSessionId !== identity.sessionId)) throw new Error('Assignment OS actor mismatch');
    if (path === enrollment && !['prepare','complete'].includes(body.action)) throw new Error('Invalid enrollment action');
    const expectedRepo = expectedRepositoryURL(identity.subject, 'a-' + attemptId);
    if ((path === enrollment && body.action === 'complete' && body.repositoryUrl !== expectedRepo) ||
        (path === media + 'begin' && body.repoOpen?.repositoryUrl !== expectedRepo)) throw new Error('Assignment repository mismatch');

    const stamp = String(now);
    const nonce = randomUUID();
    const payload = [domain,stamp,nonce,'POST',origin,path,attemptId,issuer,identity.subject,serialized].join('\n');
    const key = createHmac('sha256',secret).update(domain,'utf8').digest();
    return {
        'X-Ezil-Assignment-Timestamp':stamp,
        'X-Ezil-Assignment-Nonce':nonce,
        'X-Ezil-Assignment-Actor':identity.subject,
        'X-Ezil-Assignment-Signature':createHmac('sha256',key).update(payload,'utf8').digest('hex'),
    };
}
