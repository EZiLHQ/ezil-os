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
  url: 'https://github.com/EZiLHQ/ezil-cli/releases/download/standalone-20261120.1/ezil-cli-0.3.0-standalone.20261120.1.tar.gz',
  archiveSha256: 'dd757a2f04e3dfe2b8e3b731af0dfbd1123157de687b69b9a2a718a2b8ab6bc0',
  cliSha256: '6d160f821577ee4e51fb0771fe5fa56f36a40a7b8c59b16d424fc12b7e7d3225',
  supervisorSha256: REPO_OPEN_SUPERVISOR_SHA256,
  sourceCommit: '96478c69f684f4f054b5bb5792abc85c74d709dc',
  version: '0.3.0-standalone.20261120.1',
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
