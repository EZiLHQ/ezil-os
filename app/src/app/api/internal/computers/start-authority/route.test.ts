import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleDeployment as deployment } from '../../../../../../tests/fixtures/lifecycle';

const captured = vi.hoisted(() => ({ handler: vi.fn(), authorize: vi.fn(), database: {}, env: {
    EZIL_START_AUTHORITY_ENABLED: 'true', EZIL_START_AUTHORITY_SECRET: 'ab'.repeat(32),
    EZIL_START_CONTROL_KEY_POLICY: null as unknown, EZIL_OS_ACCESS_MODE: 'invite', EZIL_LIFECYCLE_DEPLOYMENTS: [] as unknown[],
} }));
vi.mock('@/env', () => ({ env: captured.env }));
vi.mock('@/server/db', () => ({ db: captured.database }));
vi.mock('@/server/app-platform/computer-start-delivery', () => ({ authorizeComputerStart: captured.authorize }));
vi.mock('@/server/app-platform/computer-start-authority-http', () => ({ createStartAuthorityHandler: captured.handler }));
afterEach(() => { vi.clearAllMocks(); vi.resetModules(); });
it('binds the service route to operator policy and the current-authority DB implementation', async () => {
    const policy = { accountId: deployment.accountId, region: deployment.region, namespace: deployment.namespace,
        controlDomain: 'control.example.com', kmsKeyArn: deployment.dataKeyArn };
    captured.env.EZIL_START_CONTROL_KEY_POLICY = policy; captured.env.EZIL_LIFECYCLE_DEPLOYMENTS = [deployment];
    const route = await import('./route'); expect(route.runtime).toBe('nodejs'); expect(route.dynamic).toBe('force-dynamic');
    expect(captured.handler).toHaveBeenCalledOnce();
    const options = captured.handler.mock.calls[0]![0];
    expect(options.enabled).toBe(true); expect(options.secret).toBe(captured.env.EZIL_START_AUTHORITY_SECRET);
    const work = { controlKey: { policy: { controlDomain: 'untrusted.example.com' } } };
    captured.authorize.mockResolvedValue(false); expect(await options.authorize(work)).toBe(false);
    expect(captured.authorize).toHaveBeenCalledWith({ database: captured.database, enabled: true, osAccessMode: 'invite',
        deployments: [deployment], keys: { policy } }, work);
    captured.authorize.mockClear(); captured.env.EZIL_START_CONTROL_KEY_POLICY = null;
    expect(await options.authorize(work)).toBe(false); expect(captured.authorize).not.toHaveBeenCalled();
});
