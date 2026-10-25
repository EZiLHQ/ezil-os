import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmAwsStop, routeComputer, type RoutedComputer } from '@/server/api/routers/compute-dispatch';
import { stopComputerForPolicy } from './stop-policy';

vi.mock('@/server/api/routers/compute-dispatch', () => ({ routeComputer: vi.fn(), confirmAwsStop: vi.fn() }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', () => ({ newCorrelationId: () => 'generated' }));

const db = {};
const computer = { userId: 'owner', computerId: 'computer' };
const ctx = { correlationId: 'correlation' };
const result = { ok: true, terminated: true, outcome: 'destroyed' };

beforeEach(() => vi.resetAllMocks());

describe('stopComputerForPolicy', () => {
    it.each(['user_stop', 'session_max', 'allowance_exhausted', 'overage_cap'] as const)('AWS %s uses stop(user), never retire', async reason => {
        const provider = { stop: vi.fn().mockResolvedValue(result), terminate: vi.fn() };
        const route = vi.fn<typeof routeComputer>().mockResolvedValue({ kind: 'aws-ec2', provider, instanceType: 'm6i.large' } as unknown as RoutedComputer);
        expect(await stopComputerForPolicy(db, computer, reason, { route, ...ctx })).toEqual({ kind: 'aws-ec2', result });
        expect(route).toHaveBeenCalledExactlyOnceWith(db, computer); // no pinCloudflare
        expect(provider.stop).toHaveBeenCalledExactlyOnceWith(ctx, computer, 'user');
        expect(provider.terminate).not.toHaveBeenCalled();
        expect(confirmAwsStop).not.toHaveBeenCalled();
    });

    it('confirm waits through confirmAwsStop with the same context and owner', async () => {
        const provider = { stop: vi.fn(), terminate: vi.fn() };
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'aws-ec2', provider, instanceType: null } as unknown as RoutedComputer);
        vi.mocked(confirmAwsStop).mockResolvedValue(result);
        expect(await stopComputerForPolicy(db, computer, 'user_stop', { confirm: true, ...ctx })).toEqual({ kind: 'aws-ec2', result });
        expect(confirmAwsStop).toHaveBeenCalledExactlyOnceWith(provider, ctx, computer);
        expect(provider.terminate).not.toHaveBeenCalled();
    });

    it.each([false, true])('Cloudflare flushes and terminates, including confirm=%s', async confirm => {
        const provider = { stop: vi.fn(), terminate: vi.fn().mockResolvedValue(result) };
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'cloudflare', provider } as unknown as RoutedComputer);
        expect(await stopComputerForPolicy(db, computer, 'session_max', { confirm })).toEqual({ kind: 'cloudflare', result });
        expect(provider.terminate).toHaveBeenCalledExactlyOnceWith({ correlationId: 'session_max:generated' }, computer);
        expect(provider.stop).not.toHaveBeenCalled();
        expect(confirmAwsStop).not.toHaveBeenCalled();
    });
});
