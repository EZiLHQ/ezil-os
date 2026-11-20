/** Ephemeral CLI delivery for image 1.0.39; the public artifact is separately pinned from the image. */
import type { RepoOpenExec } from './repo-open';
import { REPO_OPEN_STAGE_B64, REPO_OPEN_SUPERVISOR_B64, REPO_OPEN_SUPERVISOR_SHA256 } from './repo-open-runtime.generated';

export interface StandaloneCliPin {
  url: string;
  archiveSha256: string;
  cliSha256: string;
  supervisorSha256: string;
  sourceCommit: string;
  version: string;
}

/** Public standalone CLI release; the release owner verified the published archive and entry bytes. */
export const STANDALONE_CLI_CANDIDATE: StandaloneCliPin = {
  url: 'https://github.com/EZiLHQ/ezil-cli/releases/download/standalone-20261120.2/ezil-cli-0.3.0-standalone.20261120.2.tar.gz',
  archiveSha256: '8668d5e06b6cd35140a2853c26f4e96bcd2b8b40b353ddc4d98161f1488d9b33',
  cliSha256: 'add3f83cef4b35e8a65f43af3d4ad8ed745c5fa25b6d728b21ad8f0500d63049',
  supervisorSha256: REPO_OPEN_SUPERVISOR_SHA256,
  sourceCommit: '542c127493179e0075f755d72a2dbd04710c75b9',
  version: '0.3.0-standalone.20261120.2',
};

/** Enabled after release-owner verification of the public download against the exact pins above. */
export const STANDALONE_CLI_RELEASE_READY = true;
export const STANDALONE_CLI_STAGE_TIMEOUT_MS = 20_000;

function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function standaloneCliStageCommand(pin: StandaloneCliPin): string {
  const loader = `import base64;exec(compile(base64.b64decode('${REPO_OPEN_STAGE_B64}'),'stage.py','exec'))`;
  return `python3 -I -c ${shq(loader)} ${shq(JSON.stringify(pin))} ${shq(REPO_OPEN_SUPERVISOR_B64)}`;
}

/** Called only after the Worker has confirmed the computer is running. No credential is in this exec. */
export async function ensureStandaloneCliRuntime(exec: RepoOpenExec): Promise<boolean> {
  if (!STANDALONE_CLI_RELEASE_READY) return false;
  try {
    const result = await exec(standaloneCliStageCommand(STANDALONE_CLI_CANDIDATE), {
      env: {}, timeout: STANDALONE_CLI_STAGE_TIMEOUT_MS, origin: 'internal',
    });
    return result.exitCode === 0 && result.stdout?.trim() === 'ezil-cli-bootstrap:ok';
  } catch {
    return false;
  }
}
