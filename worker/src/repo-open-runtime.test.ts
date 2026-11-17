import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPO_OPEN_STAGE_B64, REPO_OPEN_STAGE_SHA256, REPO_OPEN_SUPERVISOR_B64,
  REPO_OPEN_SUPERVISOR_SHA256 } from './repo-open-runtime.generated';
import { ensureStandaloneCliRuntime, standaloneCliStageCommand, STANDALONE_CLI_CANDIDATE,
  STANDALONE_CLI_RELEASE_READY, STANDALONE_CLI_STAGE_TIMEOUT_MS } from './repo-open-runtime';

const source = (name: string) => readFileSync(fileURLToPath(new URL(`../repo-open/${name}`, import.meta.url)));
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('ephemeral standalone CLI source pin', () => {
  it('agrees with the host pin and derives the asset name from its version', () => {
    const host = JSON.parse(readFileSync(new URL('../../infra/host-agent/lib/ezil_host/standalone_git_assets/pin.json', import.meta.url), 'utf8'));
    expect(STANDALONE_CLI_CANDIDATE).toEqual(host);
    const version = STANDALONE_CLI_CANDIDATE.version;
    const release = version.split('-standalone.')[1];
    expect(STANDALONE_CLI_CANDIDATE.url).toBe(`https://github.com/EZiLHQ/ezil-cli/releases/download/standalone-${release}/ezil-cli-${version}.tar.gz`);
  });
  it('bundles the exact reviewed OS Python sources', () => {
    for (const [name, encoded, expected] of [
      ['stage.py', REPO_OPEN_STAGE_B64, REPO_OPEN_STAGE_SHA256],
      ['supervise.py', REPO_OPEN_SUPERVISOR_B64, REPO_OPEN_SUPERVISOR_SHA256],
    ]) {
      const bytes = source(name);
      expect(Buffer.from(encoded, 'base64')).toEqual(bytes);
      expect(sha(bytes)).toBe(expected);
    }
    expect(STANDALONE_CLI_CANDIDATE.supervisorSha256).toBe(REPO_OPEN_SUPERVISOR_SHA256);
  });
  it('puts only public pin and source data in the staging command', () => {
    const command = standaloneCliStageCommand(STANDALONE_CLI_CANDIDATE);
    expect(command).toContain('python3 -I -c');
    expect(command).toContain(STANDALONE_CLI_CANDIDATE.url);
    expect(command).toContain(STANDALONE_CLI_CANDIDATE.archiveSha256);
    expect(command).toContain(STANDALONE_CLI_CANDIDATE.cliSha256);
    expect(command).toContain(REPO_OPEN_SUPERVISOR_B64);
  });
  it('enables only the verified public .1 release pins', () => {
    expect(STANDALONE_CLI_RELEASE_READY).toBe(true);
    expect(STANDALONE_CLI_CANDIDATE).toEqual({
      url: 'https://github.com/EZiLHQ/ezil-cli/releases/download/standalone-20261115.1/ezil-cli-0.3.0-standalone.20261115.1.tar.gz',
      archiveSha256: '610b2c6fae4e5c4ea1db45b9d53a028de421ceaad927abb49be45339f9f1b7a4',
      cliSha256: 'a30361d38c0310912fbfd3c18284c78e66e0f6c474727081c19d09f9fb1a0a9b',
      supervisorSha256: REPO_OPEN_SUPERVISOR_SHA256,
      sourceCommit: '90765278ed1dc83251f23f709b270804d8802a6f',
      version: '0.3.0-standalone.20261115.1',
    });
  });
  it('stages the pinned release in one bounded credential-free exec', async () => {
    let calls = 0;
    const ready = await ensureStandaloneCliRuntime(async (command, options) => {
      calls += 1;
      expect(command).toBe(standaloneCliStageCommand(STANDALONE_CLI_CANDIDATE));
      expect(options).toEqual({ env: {}, timeout: STANDALONE_CLI_STAGE_TIMEOUT_MS, origin: 'internal' });
      return { exitCode: 0, stdout: 'ezil-cli-bootstrap:ok\n' };
    });
    expect(ready).toBe(true);
    expect(calls).toBe(1);
  });
  it.each([
    { exitCode: 1, stdout: 'ezil-cli-bootstrap:ok' },
    { exitCode: 0, stdout: 'unexpected output' },
    { exitCode: 0 },
    { exitCode: 0, stdout: 'ezil-cli-bootstrap:ok\nextra' },
  ])('rejects unsuccessful or unrecognized bootstrap results %#', async (result) => {
    expect(await ensureStandaloneCliRuntime(async () => result)).toBe(false);
  });
  it('fails closed when bootstrap exec throws', async () => {
    expect(await ensureStandaloneCliRuntime(async () => { throw new Error('exec failed'); })).toBe(false);
  });
});
