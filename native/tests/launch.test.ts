import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { launchOptions, readyLine } from '../src/launch.ts';
import { NATIVE_RUNTIME } from '../src/contract.ts';

test('Electron launch consumes the admin capability and accepts an attached workspace without reading a broker', () => {
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    const env: Record<string, string | undefined> = {
        EZIL_NATIVE_DATA_ROOT: '/tmp/data', EZIL_NATIVE_ADMIN_CAPABILITY: token,
        EZIL_NATIVE_WORKSPACE_ID: id, EZIL_NATIVE_WORKSPACE_ROOT: '/tmp/project',
        EZIL_NATIVE_BROKER_FILE: '/does/not/exist',
    };
    expect(launchOptions(env)).toEqual({ dataRoot: '/tmp/data', adminToken: token, attachedWorkspace: { id, root: '/tmp/project' } });
    expect(env.EZIL_NATIVE_ADMIN_CAPABILITY).toBeUndefined();
    const line = readyLine(49152);
    expect(line.split('\n')).toHaveLength(1);
    expect(line.startsWith('EZIL_NATIVE_READY ')).toBe(true);
    expect(JSON.parse(line.slice('EZIL_NATIVE_READY '.length))).toEqual({ contractVersion: 1, port: 49152, capabilities: NATIVE_RUNTIME });
    expect(line).not.toContain(token);
    expect(line).not.toContain('/tmp');
});

test('incomplete inherited workspaces and the obsolete admin variable fail closed', () => {
    const base = { EZIL_NATIVE_DATA_ROOT: '/tmp/data', EZIL_NATIVE_ADMIN_CAPABILITY: 'test-token' };
    for (const extra of [{ EZIL_NATIVE_WORKSPACE_ID: randomUUID() }, { EZIL_NATIVE_WORKSPACE_ROOT: '/tmp/project' },
        { EZIL_NATIVE_WORKSPACE_ID: '', EZIL_NATIVE_WORKSPACE_ROOT: '' }]) {
        expect(() => launchOptions({ ...base, ...extra })).toThrow('incomplete_workspace');
    }
    expect(() => launchOptions({ EZIL_NATIVE_DATA_ROOT: '/tmp/data', EZIL_NATIVE_ADMIN_TOKEN: 'obsolete' })).toThrow();
    expect(launchOptions({ ...base }).attachedWorkspace).toBeUndefined();
});
