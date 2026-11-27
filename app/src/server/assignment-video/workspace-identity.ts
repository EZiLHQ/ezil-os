import { createHash } from 'node:crypto';

export function workspaceIdentity(userId: string, computerId: string, sandboxName: string): string {
    return createHash('sha256').update(JSON.stringify([userId, computerId, sandboxName])).digest('hex');
}
