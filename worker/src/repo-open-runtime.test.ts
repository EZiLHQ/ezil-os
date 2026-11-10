import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { REPO_OPEN_STAGE_B64, REPO_OPEN_STAGE_SHA256, REPO_OPEN_SUPERVISOR_B64,
  REPO_OPEN_SUPERVISOR_SHA256 } from './repo-open-runtime.generated';
import { ensureStandaloneCliRuntime, standaloneCliStageCommand, STANDALONE_CLI_CANDIDATE,
  STANDALONE_CLI_RELEASE_READY } from './repo-open-runtime';

const source = (name: string) => readFileSync(fileURLToPath(new URL(`../repo-open/${name}`, import.meta.url)));
const sha = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('ephemeral standalone CLI source pin', () => {
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
  it('makes no sandbox exec while the unpublished artifact gate is false', async () => {
    expect(STANDALONE_CLI_RELEASE_READY).toBe(false);
    let called = false;
    expect(await ensureStandaloneCliRuntime(async () => { called = true; return { exitCode: 0 }; })).toBe(false);
    expect(called).toBe(false);
  });
});
