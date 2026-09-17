import { NativeError, NATIVE_RUNTIME } from './contract.ts';
import type { NativeOptions } from './server.ts';

/** The inherited launch interface is the only configuration source. */
export function launchOptions(env: Record<string, string | undefined>): NativeOptions {
    const dataRoot = env.EZIL_NATIVE_DATA_ROOT;
    const adminToken = env.EZIL_NATIVE_ADMIN_CAPABILITY;
    delete env.EZIL_NATIVE_ADMIN_CAPABILITY;
    if (!dataRoot || !adminToken) throw new NativeError('required_environment_missing');
    const id = env.EZIL_NATIVE_WORKSPACE_ID;
    const root = env.EZIL_NATIVE_WORKSPACE_ROOT;
    if ((id !== undefined || root !== undefined) && (!id || !root)) throw new NativeError('incomplete_workspace');
    // EZIL_NATIVE_BROKER_FILE belongs to Electron's model broker; do not read
    // its capability or pass its path into the renderer payload.
    return { dataRoot, adminToken, attachedWorkspace: id && root ? { id, root } : undefined };
}

export function readyLine(port: number): string {
    return `EZIL_NATIVE_READY ${JSON.stringify({ contractVersion: 1, port, capabilities: NATIVE_RUNTIME })}`;
}
