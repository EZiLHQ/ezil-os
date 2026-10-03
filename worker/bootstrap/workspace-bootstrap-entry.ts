/**
 * In-container readiness gate, bundled by build-bootstrap.sh.
 * The authenticated Worker restores Git and commits an R2 checkpoint before
 * starting the desktop. Replaying the former loose-file bootstrap here would
 * overwrite staged edits and resurrect deletions. Only a confirmed local
 * checkpoint may publish readiness; there is no legacy hydration fallback.
 * stdout contains only the resolved workspace root. Errors contain no inputs.
 */
import { checkpointReady } from './checkpoint-ready.mjs';

async function main(): Promise<void> {
    const root = await checkpointReady(process.env);
    process.stdout.write(`${root}\n`);
}

void main().catch(() => {
    process.stderr.write('[workspace-bootstrap] fail-closed workspace_checkpoint_unconfirmed\n');
    process.exit(1);
});
