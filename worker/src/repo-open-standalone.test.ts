import { describe, expect, it } from 'bun:test';

import { parsePrivateCliOutput, parseRepoOpenRequest, repoOpenCliCommand, runRepoOpen, type RepoOpenRequest } from './repo-open';
import { grantRequestFromOpen } from './repo-grant';
import { standaloneCliStageCommand, STANDALONE_CLI_CANDIDATE } from './repo-open-runtime';

const CHECKOUT = '44444444-4444-4444-8444-444444444444';
const URL = 'https://github.ezil.work/default/os-code-url-20261110-a.git';
const TOKEN = 'opaque-gateway-credential';
const NOW = Date.parse('2026-11-10T17:00:00.000Z');
const NATIVE_TOKEN = `art_v1_${'a'.repeat(40)}?expires=${Math.floor((NOW + 240_000) / 1000)}`;
const packet = () => ({ version: 2, repository: { id: 'fg1wtcrexaf7acl0', canonicalURL: URL, ref: 'refs/heads/main' },
  identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|fixture' },
  git: { username: 'ezil', token: TOKEN, expiresAt: '2026-11-10T17:04:00.000Z', scope: 'read' } });
const body = () => ({ repositoryId: CHECKOUT, privatePacket: packet(), timeoutMs: 60_000 });
const root = { path: '/workspace', requireHydrated: true };
const accepted = (): RepoOpenRequest => {
  const parsed = parseRepoOpenRequest(body(), NOW);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.request;
};

describe('standalone CLI v2 Worker open', () => {
  it('keeps the real Cloudflare repository ID separate from the OS checkout UUID', () => {
    const request = accepted();
    expect(request.repositoryId).toBe(CHECKOUT);
    expect(request.privatePacket?.repository.id).toBe('fg1wtcrexaf7acl0');
    expect(request.canonicalURL).toBe(URL);
    expect(request.ref).toBe('refs/heads/main');
    expect(grantRequestFromOpen(request, NOW)).toBeNull();
  });
  it('accepts a native Artifacts ?expires credential as opaque fd-only data', () => {
    const native = { ...body(), privatePacket: { ...packet(), git: { ...packet().git, token: NATIVE_TOKEN } } };
    const parsed = parseRepoOpenRequest(native, NOW);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const prepared = repoOpenCliCommand(parsed.request, root);
    expect(prepared.command).not.toContain(NATIVE_TOKEN);
    expect(JSON.parse(prepared.packet).git.token).toBe(NATIVE_TOKEN);
    expect(parseRepoOpenRequest({ ...native, privatePacket: { ...native.privatePacket,
      git: { ...native.privatePacket.git, token: `${NATIVE_TOKEN}:unsafe` } } }, NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
  });
  it.each([
    ['provider ID', () => ({ ...body(), privatePacket: { ...packet(), repository: { ...packet().repository, id: '../bad' } } })],
    ['URL', () => ({ ...body(), privatePacket: { ...packet(), repository: { ...packet().repository, canonicalURL: 'https://github.ezil.work/default/../other.git' } } })],
    ['double .git URL', () => ({ ...body(), privatePacket: { ...packet(), repository: { ...packet().repository, canonicalURL: 'https://github.ezil.work/default/site.git.git' } } })],
    ['ref', () => ({ ...body(), privatePacket: { ...packet(), repository: { ...packet().repository, ref: 'refs/heads/../bad' } } })],
    ['issuer', () => ({ ...body(), privatePacket: { ...packet(), identity: { ...packet().identity, issuer: 'https://other.invalid/' } } })],
    ['subject control byte', () => ({ ...body(), privatePacket: { ...packet(), identity: { ...packet().identity, subject: 'auth0|bad\nsubject' } } })],
    ['scope', () => ({ ...body(), privatePacket: { ...packet(), git: { ...packet().git, scope: 'admin' } } })],
    ['non-HTTP-safe token', () => ({ ...body(), privatePacket: { ...packet(), git: { ...packet().git, token: 'opaque:gateway:credential' } } })],
    ['overlong grant', () => ({ ...body(), privatePacket: { ...packet(), git: { ...packet().git, expiresAt: '2026-11-10T17:05:01.000Z' } } })],
    ['extra field', () => ({ ...body(), privatePacket: { ...packet(), projectId: 'forbidden' } })],
  ])('rejects invalid %s', (_name, changed) => {
    expect(parseRepoOpenRequest(changed(), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
  });
  it('refuses a credential that cannot last through the requested operation', () => {
    const shortened = { ...body(), privatePacket: { ...packet(), git: { ...packet().git, expiresAt: '2026-11-10T17:00:30.000Z' } } };
    expect(parseRepoOpenRequest(shortened, NOW)).toEqual({ ok: false, error: 'repo_open_token_expired' });
  });
  it('hands the exact v2 packet on fd 3, never in argv, and opens only the F3 wrapper', async () => {
    const request = accepted();
    const prepared = repoOpenCliCommand(request, root);
    expect(prepared.command).toContain('3<<<"$p"');
    expect(prepared.command).toContain('exec python3 -I /run/ezil/bin/supervise.py');
    expect(prepared.command).not.toContain('exec python3 /run/ezil/bin/supervise.py');
    expect(prepared.command).toContain(STANDALONE_CLI_CANDIDATE.cliSha256);
    expect(prepared.command).toContain(STANDALONE_CLI_CANDIDATE.version);
    expect(prepared.command).not.toContain(TOKEN);
    expect(JSON.parse(prepared.packet)).toEqual(packet());
    const output = JSON.stringify({ canonicalUrl: URL, folder: `/workspace/projects/${CHECKOUT}/repository`,
      repository: packet().repository, identity: packet().identity, status: 'cloned' });
    expect(parsePrivateCliOutput(output, request, root)).toEqual({ ok: true, folder: `/workspace/projects/${CHECKOUT}`, status: 'cloned' });
    let env: Record<string, string> | undefined;
    const result = await runRepoOpen(async (_command, options) => { env = options.env; return { exitCode: 0, stdout: output }; },
      request, root, async () => true, () => NOW);
    expect(result).toEqual({ ok: true, folder: `/workspace/projects/${CHECKOUT}`, status: 'cloned' });
    expect(env).toEqual({ EZIL_REPO_OPEN_CLI_PACKET: JSON.stringify(packet()) });
    expect(parsePrivateCliOutput(output.replace('/repository', '/outside'), request, root)).toBeNull();
    expect(parsePrivateCliOutput(output.replace(`/workspace/projects/${CHECKOUT}/repository`, `/workspace/projects/${CHECKOUT}`), request, root)).toBeNull();
    expect(parsePrivateCliOutput(JSON.stringify({ ...JSON.parse(output), repository: { ...packet().repository, id: 'otherproviderid01' } }), request, root)).toBeNull();
    expect(parsePrivateCliOutput(JSON.stringify({ ...JSON.parse(output), repository: { ...packet().repository, ref: 'refs/heads/other' } }), request, root)).toBeNull();
  });
  it('stages the public release before handing the private packet to the CLI', async () => {
    let calls = 0;
    const output = JSON.stringify({ canonicalUrl: URL, folder: `/workspace/projects/${CHECKOUT}/repository`,
      repository: packet().repository, identity: packet().identity, status: 'cloned' });
    const answer = await runRepoOpen(async (command, options) => {
      calls += 1;
      if (calls === 1) {
        expect(command).toBe(standaloneCliStageCommand(STANDALONE_CLI_CANDIDATE));
        expect(options.env).toEqual({});
        expect(command).not.toContain(TOKEN);
        return { exitCode: 0, stdout: 'ezil-cli-bootstrap:ok' };
      }
      expect(command).toContain('exec python3 -I /run/ezil/bin/supervise.py');
      expect(command).not.toContain(TOKEN);
      expect(options.env).toEqual({ EZIL_REPO_OPEN_CLI_PACKET: JSON.stringify(packet()) });
      expect(options.timeout).toBe(59_000);
      return { exitCode: 0, stdout: output };
    }, accepted(), root, undefined, () => NOW);
    expect(answer).toEqual({ ok: true, folder: `/workspace/projects/${CHECKOUT}`, status: 'cloned' });
    expect(calls).toBe(2);
  });
  it('fails closed before cloning when public runtime staging fails', async () => {
    const calls: { command: string; env: Record<string, string> | undefined }[] = [];
    const answer = await runRepoOpen(async (command, options) => {
      calls.push({ command, env: options.env });
      return { exitCode: 1 };
    }, accepted(), root, undefined, () => NOW);
    expect(answer).toEqual({ ok: false, error: 'repo_open_git_missing' });
    expect(calls).toEqual([{ command: standaloneCliStageCommand(STANDALONE_CLI_CANDIDATE), env: {} }]);
    expect(calls[0].command).not.toContain(TOKEN);
  });
  it('charges bootstrap time to the open deadline and never starts an unbounded clone', async () => {
    let clock = NOW;
    let called = false;
    const answer = await runRepoOpen(async () => { called = true; return { exitCode: 0 }; }, accepted(), root,
      async () => { clock += 45_000; return true; }, () => clock);
    expect(answer).toEqual({ ok: false, error: 'repo_open_timeout' });
    expect(called).toBe(false);
  });
});
