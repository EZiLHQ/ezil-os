/**
 * The SSM delivery as AWS-RunShellScript runs it: `commands` joined into one script that /bin/sh executes. Real /bin/sh and
 * /bin/bash processes; python3 is a PATH stub, the run directory is re-pointed into a temp directory, and nothing outside
 * that temp directory is written.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { attestScriptLines, bashLauncher, buildAttestCommand, parseAttestCommand } from './aws-lower-attestation';
import { commandInput } from './aws-lower-attestation.test-support';

const dir = mkdtempSync(join(tmpdir(), 'ezil-attest-launcher-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const shRejectsPipefail = spawnSync('/bin/sh', ['-c', 'set -o pipefail'], { stdio: 'ignore' }).status !== 0;
/** sha256 of the six lines the fixture produced before the launcher (the pre-fix `buildAttestCommand` output). */
const PRE_LAUNCHER_LINES_SHA256 = '5776b85be5a5d6ec7774efd6ace9b3381a6f523ec9f0aa693484b4d13dbc71ff';

let runs = 0;
/** One AWS-RunShellScript run: the commands as one script file, executed by /bin/sh with only `env`. */
function runAsSsm(commands: readonly string[], env: Record<string, string> = {}) {
    const script = join(dir, `generated_script_${runs++}.sh`);
    writeFileSync(script, commands.join('\n') + '\n');
    // Only these variables, nothing inherited (the app's ProcessEnv type requires NODE_ENV, which a host script never gets).
    const r = spawnSync('/bin/sh', [script], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } as unknown as NodeJS.ProcessEnv, timeout: 10_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('the AWS-RunShellScript launcher', () => {
    it('runs a hostile body under bash, byte for byte, and returns its exit status', () => {
        const payload = `it's 'single' "double" $HOME $(echo sub) \`echo tick\` \\back !bang '\\'' %s\n\tsecond line ''`;
        const body = ['set -euo pipefail', 'true | true', 'printf "%s\\n" "${BASH_VERSION:+bash}"', "cat <<'EZIL_END'", payload, 'EZIL_END', 'exit 7'].join('\n');
        const r = runAsSsm([bashLauncher(body)]);
        expect(r.stderr).toBe('');
        expect(r.stdout).toBe(`bash\n${payload}\n`);
        expect(r.status).toBe(7);
    });

    it('stops at the first failing body line (set -euo pipefail holds inside the launcher)', () => {
        const r = runAsSsm([bashLauncher(['set -euo pipefail', 'echo before', 'false | true', 'echo after'].join('\n'))]);
        expect(r).toEqual({ status: 1, stdout: 'before\n', stderr: '' });
    });

    it('delivers exactly the six pre-launcher attestation lines as one bash body', () => {
        const lines = attestScriptLines(commandInput());
        expect(createHash('sha256').update(JSON.stringify(lines)).digest('hex')).toBe(PRE_LAUNCHER_LINES_SHA256);
        expect(buildAttestCommand(commandInput())).toEqual([bashLauncher(lines.join('\n'))]);
        expect(parseAttestCommand(buildAttestCommand(commandInput()))).toEqual(commandInput());
    });

    // The production command end to end, isolated: its run directory is re-pointed into the temp directory (every occurrence,
    // nothing else changed), install/base64/sha256sum are the real programs on temp files, and python3 is a stub that records
    // its arguments instead of loading the host agent.
    it('the production command runs every step under /bin/sh; the bare pre-launcher lines stop at `set -o pipefail`', () => {
        const stubs = join(dir, 'stubs'), log = join(dir, 'python3.log'), runDir = join(dir, 'run-ezil-attest');
        expect(runDir).toMatch(/^[A-Za-z0-9/._-]+$/);   // safe inside the single-quoted body
        mkdirSync(stubs);
        writeFileSync(join(stubs, 'python3'), '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$EZIL_STUB_LOG"\n');
        chmodSync(join(stubs, 'python3'), 0o755);
        const env = { PATH: `${stubs}:/usr/bin:/bin`, EZIL_STUB_LOG: log };
        const isolate = (commands: readonly string[]) => commands.map(line => line.replaceAll('/run/ezil-attest', runDir));

        const [launcher] = buildAttestCommand(commandInput());
        expect(launcher!.split('/run/ezil-attest').length - 1).toBe(4);   // install, write, check, loader path: and nowhere else
        const fixed = runAsSsm(isolate(buildAttestCommand(commandInput())), env);
        expect(isolate([launcher!])[0]).not.toContain('/run/ezil-attest');
        expect(fixed).toEqual({ status: 0, stdout: '', stderr: '' });
        expect(statSync(runDir).mode & 0o777).toBe(0o700);
        expect(createHash('sha256').update(readFileSync(join(runDir, 'attest.py'))).digest('hex')).toBe(commandInput().sourceSha256);
        const c = commandInput();
        expect(readFileSync(log, 'utf8')).toBe(`-I -c ${attestScriptLines(c)[5]!.split("-I -c '")[1]!.split("' --attestation-id")[0]!.replaceAll('/run/ezil-attest', runDir)}`
            + ` --attestation-id ${c.attestationId} --computer-id ${c.computerId} --original-volume-id ${c.originalVolumeId} --clone-volume-id ${c.cloneVolumeId}`
            + ` --snapshot-id ${c.snapshotId} --fs-uuid ${c.fsUuid} --instance-id ${c.instanceId} --generation ${c.generation} --lease-epoch ${c.leaseEpoch}`
            + ` --challenge ${c.challenge}\n`);

        rmSync(runDir, { recursive: true, force: true });
        rmSync(log, { force: true });
        const bare = runAsSsm(isolate(attestScriptLines(commandInput())), env);
        if (shRejectsPipefail) {
            expect(bare.status).toBe(2);
            expect(bare.stderr).toMatch(/Illegal option -o pipefail/);
            expect(existsSync(runDir)).toBe(false);
            expect(existsSync(log)).toBe(false);
        }
    });
});
