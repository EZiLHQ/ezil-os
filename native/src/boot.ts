import type { ShellBootPayload } from '../../app/src/server/shell/boot-payload.ts';
import { NATIVE_RUNTIME } from './contract.ts';
import type { WorkspaceRecord } from './workspaces.ts';

export function nativeBoot(record: WorkspaceRecord): ShellBootPayload {
    return {
        user: { id: record.guestId, email: null },
        computer: { id: record.id, name: record.name, slot: 0, createdAt: record.createdAt, lastOpenedAt: null, isNew: false },
        apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
        desktopState: {
            provider: 'native-macos', configured: true, hasHmacSecret: false, status: 'idle',
            endpoints: {}, runtime: NATIVE_RUNTIME,
        },
    };
}
