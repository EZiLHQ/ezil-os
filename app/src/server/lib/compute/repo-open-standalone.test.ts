import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestRepoOpen } from './repo-open';
import type { ControlTarget } from './aws-control-auth';
import type { PrivateGitPacket } from '@/server/git/private-packet';

const CHECKOUT = '44444444-4444-4444-8444-444444444444';
const URL = 'https://github.ezil.work/default/os-code-url-20261110-a.git';
const TOKEN = 'opaque-gateway-credential';
const packet: PrivateGitPacket = { version: 2, repository: { id: 'fg1wtcrexaf7acl0', canonicalURL: URL, ref: 'refs/heads/main' },
    identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|fixture' },
    git: { username: 'ezil', token: TOKEN, expiresAt: '2026-11-10T17:10:00.000Z', scope: 'read' } };
const computer = { userId: '11111111-1111-4111-8111-111111111111', computerId: '22222222-2222-4222-8222-222222222222' };
const cloudflare: ControlTarget = { sandboxName: 'guac-a-b', auth: { kind: 'v1' } };
const aws: ControlTarget = { sandboxName: 'guac-a-b', auth: { kind: 'v2', claims: { sandboxId: 'guac-a-b', computerId: computer.computerId,
    userId: computer.userId, provider: 'aws-ec2', store: '', generation: 2, leaseEpoch: 4 } } };
const request = { repositoryId: CHECKOUT, canonicalURL: URL, ref: packet.repository.ref,
    git: { token: TOKEN, expiresAt: packet.git.expiresAt, scope: packet.git.scope }, privatePacket: packet, timeoutMs: 60_000 };

afterEach(() => vi.restoreAllMocks());

describe('standalone OS to Worker transport', () => {
    it('signs and sends only the v2 packet and checkout UUID, and accepts only its wrapper folder', async () => {
        const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
            expect(JSON.parse(String(init.body))).toEqual({ repositoryId: CHECKOUT, privatePacket: packet, timeoutMs: 60_000 });
            expect(String(_url)).not.toContain(TOKEN);
            expect(String(_url)).toContain(`/sandbox/${cloudflare.sandboxName}/repo-open`);
            expect(Object.keys(Object.fromEntries(new Headers(init.headers))).some(key => key.toLowerCase() === 'x-ezil-auth')).toBe(true);
            return Response.json({ ok: true, folder: `/workspace/projects/${CHECKOUT}` });
        });
        expect(await requestRepoOpen('https://worker.example', 'secret', cloudflare, computer, request,
            { fetch: fetcher as unknown as typeof fetch })).toEqual({ ok: true, folder: `/workspace/projects/${CHECKOUT}` });
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it('does not send a mismatched packet or an AWS target', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fetcher = vi.fn(async () => Response.json({ ok: true, folder: `/workspace/projects/${CHECKOUT}` }));
        const deps = { fetch: fetcher as unknown as typeof fetch };
        expect(await requestRepoOpen('https://worker.example', 'secret', cloudflare, computer,
            { ...request, canonicalURL: 'https://github.ezil.work/default/other.git' }, deps)).toEqual({ ok: false, errorCode: 'repo_open_failed' });
        expect(await requestRepoOpen('https://worker.example', 'secret', aws, computer, request, deps)).toEqual({ ok: false, errorCode: 'repo_open_unsupported_provider' });
        expect(fetcher).not.toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    });
});
