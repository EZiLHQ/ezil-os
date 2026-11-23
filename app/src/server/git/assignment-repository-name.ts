import { createHash } from 'node:crypto';

export const ASSIGNMENT_NAMESPACE = 'default';

/** The gateway's owner-bound repository name: `u-<first 16 hex of sha256(UTF-8 sub)>-<name>`. */
export function ownerRepositoryName(subject: string, name: string): string {
    return `u-${createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 16)}-${name}`;
}

export function expectedRepositoryURL(subject: string, name: string): string {
    return `https://github.ezil.work/${ASSIGNMENT_NAMESPACE}/${ownerRepositoryName(subject, name)}.git`;
}
