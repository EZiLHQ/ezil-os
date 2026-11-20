import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ owned: [{ owned: 1 }] as unknown[], placement: null as unknown, foreign: false, reads: 0 }));
vi.mock('server-only', () => ({}));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/db', () => ({ db: { execute: vi.fn(async () => fixture.owned) } }));
vi.mock('@/server/lib/compute/placement', async (original) => {
    const actual = await original<typeof import('@/server/lib/compute/placement')>();
    return {
        ...actual,
        readPlacement: vi.fn(async (_db: unknown, computerId: string) => {
            fixture.reads++;
            if (fixture.foreign) throw new actual.PlacementOwnerError(computerId);
            return { record: fixture.placement };
        }),
    };
});

import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { mintPreviewTokenV2 } from '@/server/lib/compute/preview-token-v2';
import { handleBrowserObserve } from './receiver';
import { awsBrowserTargetAdmitted, browserTargetClaims, resolveAwsBrowserTarget, resolveCloudflareBrowserTarget } from './target';

const computer = 'abcdef01-2222-4222-8222-222222222222';
const principal = { userId: '11111111-1111-4111-8111-111111111111', clientId: 'client-test' };
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_DELEGATED_BROWSER_OBSERVE_AWS_TARGETS: 'aws-ec2:' + computer };
const updatedAt = new Date('2026-11-20T00:00:00.000Z');
const running = (over: Record<string, unknown> = {}) => ({
    computerId: computer, ownerUserId: principal.userId, provider: 'aws-ec2', store: 'ebs',
    generation: 3, leaseEpoch: 7, state: 'RUNNING', updatedAt, ...over,
});

beforeEach(() => {
    fixture.owned = [{ owned: 1 }];
    fixture.placement = running();
    fixture.foreign = false;
    fixture.reads = 0;
});

describe('stage-only AWS Browser observation target', () => {
    it('admits only a well-formed provider-qualified list naming this exact AWS computer', () => {
        expect(awsBrowserTargetAdmitted('aws-ec2:' + computer, computer)).toBe(true);
        expect(awsBrowserTargetAdmitted('cloudflare:' + '3'.repeat(8) + computer.slice(8) + ', aws-ec2:' + computer, computer)).toBe(true);
        for (const raw of [undefined, '', 'cloudflare:' + computer, computer, 'aws-ec2:' + computer + ',bogus',
            'aws-ec2:' + computer + ':x', 'aws-ec2:' + computer.toUpperCase()]) {
            expect(awsBrowserTargetAdmitted(raw, computer)).toBe(false);
        }
        expect(awsBrowserTargetAdmitted('aws-ec2:' + computer, computer.toUpperCase())).toBe(false);
    });

    it('binds a RUNNING owned lease and signs the exact provider claims the Worker checks', async () => {
        const target = await resolveAwsBrowserTarget(principal, computer, 'ezil-browser-observe-v1', env);
        const sandboxId = deriveGuacamoleSandboxId(principal.userId, computer);
        expect(target).toEqual({
            sandboxId, provider: 'aws-ec2', generation: 3, leaseEpoch: 7,
            binding: createHash('sha256').update(JSON.stringify(['ezil-browser-observe-v1', principal.userId, principal.clientId,
                computer, sandboxId, 'aws-ec2', 3, 7, updatedAt.toISOString()])).digest('hex'),
        });
        expect(browserTargetClaims(target!)).toEqual({ provider: 'aws-ec2', store: '', generation: 3, leaseEpoch: 7 });
        const token = mintPreviewTokenV2('secret', { ts: 1, sandboxId, computerId: computer, userId: principal.userId,
            ...browserTargetClaims(target!) }, { method: 'POST', path: '/sandbox/' + sandboxId + '/browser-observe', body: '{}' });
        expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({
            provider: 'aws-ec2', store: '', generation: 3, leaseEpoch: 7, sandboxId, computerId: computer,
        });
        // Any lease movement changes the binding the receiver compares after the observation.
        for (const over of [{ leaseEpoch: 8 }, { generation: 4 }, { updatedAt: new Date(updatedAt.getTime() + 1) }]) {
            fixture.placement = running(over);
            expect((await resolveAwsBrowserTarget(principal, computer, 'ezil-browser-observe-v1', env))?.binding).not.toBe(target!.binding);
        }
    });

    it('fails closed when unlisted, disabled, killed, not owned, foreign, not RUNNING, or not on a real lease', async () => {
        for (const refused of [{ ...env, EZIL_DELEGATED_BROWSER_OBSERVE_AWS_TARGETS: undefined },
            { ...env, EZIL_AWS_COMPUTERS_ENABLED: '0' }, { ...env, EZIL_AWS_KILL_SWITCH: '1' }]) {
            expect(await resolveAwsBrowserTarget(principal, computer, 'ezil-browser-observe-v1', refused)).toBeNull();
        }
        expect(fixture.reads).toBe(0);
        fixture.owned = [];
        expect(await resolveAwsBrowserTarget(principal, computer, 'ezil-browser-observe-v1', env)).toBeNull();
        fixture.owned = [{ owned: 1 }];
        fixture.foreign = true;
        expect(await resolveAwsBrowserTarget(principal, computer, 'ezil-browser-observe-v1', env)).toBeNull();
        fixture.foreign = false;
        for (const over of [{ provider: 'cloudflare' }, { state: 'STOPPED' }, { state: 'STOPPING' }, { state: 'LEASED' },
            { generation: 0 }, { leaseEpoch: 0 }]) {
            fixture.placement = running(over);
            expect(await resolveAwsBrowserTarget(principal, computer, 'ezil-browser-observe-v1', env)).toBeNull();
        }
        fixture.placement = null;
        expect(await resolveAwsBrowserTarget(principal, computer, 'ezil-browser-observe-v1', env)).toBeNull();
    });

    it('leaves the Cloudflare target, its binding and its claims unchanged, and never serves AWS through it', async () => {
        fixture.placement = { ...running(), provider: 'cloudflare', store: 'r2', generation: 0, leaseEpoch: 0, state: 'RUNNING' };
        const target = await resolveCloudflareBrowserTarget(principal, computer, 'ezil-browser-observe-v1');
        const sandboxId = deriveGuacamoleSandboxId(principal.userId, computer);
        expect(target).toEqual({ sandboxId, binding: createHash('sha256').update(JSON.stringify([
            'ezil-browser-observe-v1', principal.userId, principal.clientId, computer, sandboxId, updatedAt.toISOString(),
        ])).digest('hex') });
        expect(browserTargetClaims(target!)).toEqual({ provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0 });
        fixture.placement = running();
        expect(await resolveCloudflareBrowserTarget(principal, computer, 'ezil-browser-observe-v1')).toBeNull();
    });

    it('answers nothing observed when the AWS lease moves during the observation', async () => {
        const path = '/api/mcp/browser-sessions/' + computer + '/observe';
        const now = Date.parse('2026-11-20T00:00:00.000Z');
        const observed = { ok: true, browserSessionId: 'a'.repeat(43), expiresAt: new Date(now + 60_000).toISOString(),
            observed: 'profile_builder', profileHeadingVisible: true, universeIdentity: 'unverified' };
        const observe = vi.fn(async () => { fixture.placement = running({ leaseEpoch: 8 }); return observed; });
        const response = await handleBrowserObserve(new Request('https://os-staging.ezil.work' + path, {
            method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
        }), {
            enabled: true, now: () => now, verify: async () => principal, observe,
            target: (p, id) => resolveAwsBrowserTarget(p, id, 'ezil-browser-observe-v1', env),
        });
        expect(observe).toHaveBeenCalledWith(principal, computer, expect.objectContaining({ provider: 'aws-ec2', leaseEpoch: 7 }), {});
        expect([response.status, await response.json()]).toEqual([409, { ok: false, error: 'browser_session_stale' }]);
    });
});
