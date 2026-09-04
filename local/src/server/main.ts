/**
 * `bun run start` — the local host's entry point.
 *
 * Reads the configuration, builds a `SandboxHost`, starts the server, prints
 * one honest startup block and stays up. Everything it can say about the state
 * of the machine, it says here — a user whose desktop will not start should
 * learn why from this block rather than from a blank page.
 *
 * ── `--fake-host` ───────────────────────────────────────────────────────────
 * The real adapter is `../host/docker-host.ts` and `resolveHost()` below now
 * constructs it (row T5). `--fake-host` remains, as the way to run this process
 * end to end with no Docker at all — CI's three-OS matrix and the contract
 * suite use it. It is LOUD: the startup block says outright that no container
 * will be started, so nobody can mistake a fake boot for a real one.
 *
 * 🔴 THERE IS STILL NO FALLBACK, AND THAT IS THE RULE. Without `--fake-host`
 * this process constructs a real `DockerHost` and a boot that cannot reach the
 * daemon FAILS. It never degrades to the fake, because a host that quietly
 * served a fake desktop when Docker was missing would be exactly the
 * "asserting health it has not confirmed" failure this project keeps closing.
 * `bun run --cwd local doctor` is the thing that tells a user WHY before they
 * ever start the server.
 */

import { ENV_KEYS, loadConfig, type LocalConfig } from '../config.ts';
import { localUrlFor, offsetPortMap } from '../container/run-spec.ts';
import { DockerHost } from '../host/docker-host.ts';
import type { SandboxHost } from '../host/sandbox-host.ts';
import { FakeSandboxHost } from './fake-host.ts';
import { startLocalServer, type LocalServer } from './server.ts';

export interface MainOptions {
    readonly argv: readonly string[];
    readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Was `--fake-host` passed? A flag, not an environment variable: it must be visible in the process list that started it. */
export function wantsFakeHost(argv: readonly string[]): boolean {
    return argv.includes('--fake-host');
}

/**
 * The `SandboxHost` this process will drive.
 *
 * 🔴 THE ONE PLACE THE REAL ADAPTER IS CONSTRUCTED, AND THEREFORE THE ONE
 * PLACE THE THREE FACTS ABOUT THIS MACHINE MEET IT: which image reference
 * `deploy/images.env` resolved to, which host directory is the workspace, and
 * how far the published ports are shifted. The offset in particular has to be
 * the SAME number the router pins the desktop origin with — one config field,
 * read once, handed to both — because when they disagreed every cold boot
 * answered `desktop_frame_foreign_origin` over a healthy container.
 *
 * Exported and pure so `local/tests/local-smoke.container.test.ts` drives the
 * PRODUCTION wiring rather than composing its own `DockerHost`: a smoke test
 * that builds its own host proves the adapter works and leaves this function
 * — the only thing a user actually runs — untested.
 */
export function resolveHost(argv: readonly string[], config: LocalConfig): SandboxHost {
    if (wantsFakeHost(argv)) return new FakeSandboxHost();
    return new DockerHost({
        image: config.desktopImage.ref,
        workspaceHostPath: config.workspacePath,
        hostPortOffset: config.hostPortOffset,
    });
}

/** The startup block. Every line is something observed, and the ones that are not are labelled. */
export function startupReport(config: LocalConfig, server: LocalServer, fake: boolean): string {
    const lines = [
        `EZiL OS — local host on ${server.url}`,
        `  open           ${server.url}/os`,
        `  workspace      ${config.workspacePath}`,
        `  state          ${config.stateDir}`,
        `  telemetry      ${config.telemetryPath} (NDJSON, never sent anywhere)`,
        `  computer id    ${server.computer.id()}`,
        `  desktop image  ${config.desktopImage.ref} (${config.desktopImage.source}${config.desktopImage.reason ? `: ${config.desktopImage.reason}` : ''})`,
        config.shellAssetsDir === null
            ? `  shell bundle   NOT FOUND — /os will load nothing. Looked in: ${config.shellAssetsSearched.join(', ')}`
            : `  shell bundle   ${config.shellAssetsDir}`,
        // 🔴 THE OFFSET MAP, NOT THE CONSTANTS. Printing `LOCAL_PORT_MAP` on a
        // host running with an offset would tell the user to open a port
        // nothing is listening on — the startup block's whole job is to be the
        // place a user learns where their desktop is.
        `  desktop port   ${localUrlFor('desktop', config.hostPortOffset)}`,
        `  port offset    ${config.hostPortOffset}${config.hostPortOffset === 0 ? ' (the pinned map)' : ` (${ENV_KEYS.portOffset})`}`,
        `  ports          ${offsetPortMap(config.hostPortOffset).map((p) => `${p.name}:${p.host}/${p.protocol}`).join(' ')}`,
        // OPTIONAL and unset by default. Reported as configuration, not as a
        // capability: nothing in this package dials either of them today.
        `  mcp endpoint   ${config.mcpEndpoint ?? '(unset)'}`,
        `  app url        ${config.appUrl ?? '(unset)'}`,
    ];
    if (fake) {
        lines.push(
            '',
            '  🔴 --fake-host: NO CONTAINER WILL BE STARTED. The shell API answers from a',
            '     fixed state object, so a desktop that "boots" here has not booted.',
        );
    }
    return lines.join('\n');
}

export async function main(options: MainOptions): Promise<LocalServer> {
    const config = await loadConfig(options.env ?? process.env);
    const fake = wantsFakeHost(options.argv);
    const host = resolveHost(options.argv, config);
    const server = await startLocalServer({ config, host });
    console.info(startupReport(config, server, fake));
    return server;
}

// `import.meta.main` is true only when this file is the process entry point, so
// importing it from a test starts nothing.
if (import.meta.main) {
    await main({ argv: Bun.argv.slice(2) });
}
