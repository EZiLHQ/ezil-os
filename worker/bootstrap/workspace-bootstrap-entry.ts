/**
 * Wave 4B2A — in-container bootstrap ENTRYPOINT (bundled to
 * `dist/workspace-bootstrap.mjs` and copied into the sandbox image).
 *
 * `start-neko.sh` runs this with `bun` BEFORE launching VS Code, but ONLY when
 * the sealed startup delivery is present in the container startup environment
 * (`EZIL_WORKSPACE_STARTUP_DELIVERY`). It is a thin, dependency-free wrapper
 * around {@link runWorkspaceBootstrap}: it decodes the sealed envelope, verifies
 * it, HYDRATES `/home/neko/project` from the durable branch BEFORE readiness,
 * and writes the (non-secret) readiness marker only on success.
 *
 * Exit contract (consumed by the shell, which fails the whole container closed):
 *   - exit 0  → hydration succeeded; the workspace root printed on the LAST
 *               stdout line is the VS Code target root (identical to the
 *               hydrated root). The readiness marker has been written.
 *   - exit 1  → fail-closed. A present-but-malformed/expired/tampered delivery
 *               or a hydrate failure. NO readiness marker was written; the
 *               container MUST NOT present an empty/partial workspace as ready.
 *
 * Non-exposure: the sealed envelope / capability / nonce are NEVER printed. Only
 * safe stage/outcome/reason fields and the non-secret workspace root are logged
 * (to stderr) and the resolved root (to stdout).
 */

import { runWorkspaceBootstrap } from '../../../apps/web/client/src/server/lib/workspace-bridge/workspace-bootstrap';

async function main(): Promise<void> {
    const result = await runWorkspaceBootstrap({
        // Structured, SAFE logger — stage/outcome/reason/root only. Goes to
        // stderr so stdout stays a clean channel for the resolved root.
        log: (event, fields) => {
            process.stderr.write(`[workspace-bootstrap] ${event} ${JSON.stringify(fields)}\n`);
        },
    });

    if (!result.ok) {
        process.stderr.write(
            `[workspace-bootstrap] fail-closed reason=${result.reason}` +
                (result.startupReason ? ` startupReason=${result.startupReason}` : '') +
                '\n',
        );
        process.exit(1);
        return;
    }

    // The hydrated root IS the VS Code target root — emit it as the final stdout
    // line so the shell can point VS Code at exactly the hydrated workspace.
    process.stderr.write(
        `[workspace-bootstrap] ready workspaceRoot=${result.workspaceRoot} ` +
            `vscodeTargetRoot=${result.vscodeTargetRoot}\n`,
    );
    process.stdout.write(`${result.vscodeTargetRoot}\n`);
    process.exit(0);
}

void main().catch((err) => {
    // Never echo the delivery/capability; only the error class.
    process.stderr.write(
        `[workspace-bootstrap] fail-closed unexpected_error=${err instanceof Error ? err.name : 'unknown'}\n`,
    );
    process.exit(1);
});
