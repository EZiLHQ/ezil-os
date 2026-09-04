/**
 * A `SandboxHost` that starts no container.
 *
 * 🔴 WHY THIS EXISTS AND WHY IT IS NOT A MOCK IN A TEST FILE. Rows T1 and T2
 * are built in parallel against the same interface; this package must never
 * import `../host/docker-host.ts`, and a host server that could only be
 * exercised with Docker installed would be a host server nobody could test on
 * CI's three-OS matrix. So the real adapter is injected
 * (`startLocalServer({ host })`) and this is what the contract test and
 * `--fake-host` inject instead.
 *
 * It answers from a small, EXPLICIT state object rather than from plausible
 * defaults, because the interesting cases in `./shell-contract.test.ts` are the
 * dishonest-looking ones: a container that is `running` with a desktop that is
 * NOT ready, a `status` that could not be taken at all, a screen the adapter
 * could not read back. Every one of those has to be settable.
 *
 * 🔴 IT IS NOT A SIMULATOR AND MUST NOT BECOME ONE. Nothing here proves the
 * real adapter behaves this way — only that the SERVER turns a given host
 * answer into the response the shell expects. What the Docker adapter actually
 * does is row T2's evidence, and row T5's.
 */

import { localUrlFor } from '../container/run-spec.ts';
import type {
    ComputerId,
    ContainerState,
    DesktopMode,
    DesktopStatus,
    DesktopUrls,
    EnsureDesktopOptions,
    ExecOptions,
    ExecResult,
    FocusApp,
    FocusResult,
    RestartResult,
    SandboxHost,
    ScreenMode,
    ScreenResult,
    TerminateResult,
} from '../host/sandbox-host.ts';

export interface FakeHostState {
    ok: boolean;
    containerState: ContainerState;
    desktopReady: boolean;
    mode: DesktopMode | null;
    error?: string;
    /** What `readScreen`/`setScreen` report. `verified: false` is a first-class case. */
    screen: { width: number; height: number; verified: boolean };
    focusOk: boolean;
    restart: RestartResult;
    /** Make `ensureDesktop` throw, so the boot-failure branch is reachable. */
    ensureThrows: string | null;
    /**
     * Appended to the desktop URL, so the credential PASS-THROUGH can be tested
     * in both directions. The Docker adapter is the only thing that knows the
     * per-boot neko password; see `composeLocalDesktopUrl`'s header and the
     * hand-off in this row's report.
     */
    desktopUrlQuery: string;
}

/** A live desktop that answers everything. The starting point every test then breaks in exactly one way. */
export function healthyFakeState(): FakeHostState {
    return {
        ok: true,
        containerState: 'running',
        desktopReady: true,
        mode: 'neko',
        screen: { width: 1920, height: 1080, verified: true },
        focusOk: true,
        restart: { ok: true },
        ensureThrows: null,
        desktopUrlQuery: '',
    };
}

export class FakeSandboxHost implements SandboxHost {
    readonly state: FakeHostState;
    /** Every call, in order. What proves `status` was consulted rather than assumed. */
    readonly calls: string[] = [];

    constructor(state: FakeHostState = healthyFakeState()) {
        this.state = state;
    }

    status(id: ComputerId): Promise<DesktopStatus> {
        this.calls.push(`status:${id}`);
        const s = this.state;
        return Promise.resolve({
            ok: s.ok,
            computerId: id,
            containerState: s.containerState,
            desktopReady: s.desktopReady,
            mode: s.mode,
            ...(s.error === undefined ? {} : { error: s.error }),
        });
    }

    ensureDesktop(id: ComputerId, options: EnsureDesktopOptions): Promise<DesktopUrls> {
        this.calls.push(`ensureDesktop:${id}:${options.mode}:${options.screen ? `${options.screen.width}x${options.screen.height}` : 'default'}`);
        if (this.state.ensureThrows !== null) return Promise.reject(new Error(this.state.ensureThrows));
        return this.desktopUrls(id);
    }

    restartDesktop(id: ComputerId): Promise<RestartResult> {
        this.calls.push(`restartDesktop:${id}`);
        return Promise.resolve(this.state.restart);
    }

    focusApp(id: ComputerId, app: FocusApp): Promise<FocusResult> {
        this.calls.push(`focusApp:${id}:${app}`);
        return Promise.resolve(
            this.state.focusOk ? { ok: true } : { ok: false, detail: 'no_x_window' },
        );
    }

    readScreen(id: ComputerId): Promise<ScreenResult> {
        this.calls.push(`readScreen:${id}`);
        const s = this.state.screen;
        return Promise.resolve({ ok: true, width: s.width, height: s.height, verified: s.verified });
    }

    setScreen(id: ComputerId, mode: ScreenMode): Promise<ScreenResult> {
        this.calls.push(`setScreen:${id}:${mode.width}x${mode.height}`);
        // A real X server floors the width to a multiple of 8 and reports
        // success for what it was asked. The fake applies whatever it is given
        // and reports it back with the state's `verified`, so the SERVER's
        // read-back handling is what the test is exercising, not this.
        this.state.screen = { ...this.state.screen, width: mode.width, height: mode.height };
        return Promise.resolve({
            ok: true,
            width: mode.width,
            height: mode.height,
            verified: this.state.screen.verified,
        });
    }

    desktopUrls(id: ComputerId): Promise<DesktopUrls> {
        this.calls.push(`desktopUrls:${id}`);
        return Promise.resolve({
            desktop: `${localUrlFor('desktop')}/${this.state.desktopUrlQuery}`,
            code: localUrlFor('code'),
            appPreview: localUrlFor('appPreview'),
        });
    }

    fetchIn(id: ComputerId, port: number, _request: Request): Promise<Response> {
        this.calls.push(`fetchIn:${id}:${port}`);
        return Promise.resolve(new Response(null, { status: 501 }));
    }

    exec(id: ComputerId, argv: readonly string[], _options?: ExecOptions): Promise<ExecResult> {
        this.calls.push(`exec:${id}:${argv.join(' ')}`);
        return Promise.resolve({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    }

    terminate(id: ComputerId): Promise<TerminateResult> {
        this.calls.push(`terminate:${id}`);
        return Promise.resolve({ ok: true, terminated: this.state.containerState !== 'absent' });
    }
}
