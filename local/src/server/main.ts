/**
 * `bun run start` — the local host's entry point.
 *
 * Reads the configuration, builds a `SandboxHost`, starts the server, prints
 * one honest startup block and stays up. Everything it can say about the state
 * of the machine, it says here — a user whose desktop will not start should
 * learn why from this block rather than from a blank page.
 *
 * ── `--fake-host` ───────────────────────────────────────────────────────────
 * Row T2 owns `../host/docker-host.ts` and this package must never import it
 * (see `./fake-host.ts` for why). Until it lands there is no real adapter to
 * construct, so `--fake-host` is the only way to run this process end to end —
 * and it is what the row's own verification uses. It is LOUD: the startup block
 * says outright that no container will be started, so nobody can mistake a fake
 * boot for a real one.
 *
 * 🔴 THE HAND-OFF, STATED IN CODE. `resolveHost()` below is the ONE place the
 * real adapter gets wired in. It currently refuses rather than falling back to
 * the fake, because a host that quietly served a fake desktop when Docker was
 * missing would be exactly the "asserting health it has not confirmed" failure
 * this project keeps closing.
 */

import { loadConfig, type LocalConfig } from '../config.ts';
import { LOCAL_PORT_MAP, localUrlFor } from '../container/run-spec.ts';
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
 * 🔴 ROW T2 WIRES THE REAL ONE IN HERE, and this function is the entire change:
 * `return new DockerSandboxHost({ image: config.desktopImage.ref, workspaceHostPath: config.workspacePath })`.
 * Until then, running without `--fake-host` REFUSES rather than degrading — a
 * fallback to the fake would produce a `/os` that boots, a desktop button that
 * reports success, and no container anywhere.
 */
export function resolveHost(argv: readonly string[], _config: LocalConfig): SandboxHost {
    if (wantsFakeHost(argv)) return new FakeSandboxHost();
    throw new Error(
        'no_sandbox_host: the Docker adapter (local/src/host/docker-host.ts, row T2) is not wired in yet.'
        + ' Re-run with --fake-host to serve /os and the shell API against a host that starts no container.',
    );
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
        `  desktop port   ${localUrlFor('desktop')}`,
        `  ports          ${LOCAL_PORT_MAP.map((p) => `${p.name}:${p.host}/${p.protocol}`).join(' ')}`,
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
