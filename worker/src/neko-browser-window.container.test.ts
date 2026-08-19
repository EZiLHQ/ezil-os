/**
 * The in-stream browser window, checked against a REAL running container.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `worker/assets/ebuilder-openbox.xml` has asked for `<decor>no</decor>` on the
 * browser window for the whole life of this repo. The only thing guarding it was
 * `validate-neko-desktop.sh`, which checked that the config FILE EXISTS and that
 * `grep -q` found three literal substrings inside it. It never inspected a
 * window. The word `decor` appeared in exactly one non-vendor file in the whole
 * repository — the XML itself. So for that entire period nobody could tell the
 * difference between "openbox is undecorating the browser" and "openbox never
 * matched the rule at all".
 *
 * Neither could the two suites that touch WM_CLASS: `neko-teardown-orphans.test.ts`
 * and `neko-boot-devserver-isolation.test.ts` stub `wmctrl` with
 * `echo "0x01 0 chrome.Google-chrome stub EZiL OS Browser"`. The test SUPPLIES
 * the class string the gate is looking for. That is fine for what those suites
 * actually cover (teardown, boot ordering) — but it means the class string had
 * never once been compared against a real X server.
 *
 * This suite boots the real image, runs `validate-neko-browser-window.sh` inside
 * it, and asserts on X properties, real openbox frame geometry, real HTTP calls
 * to the neko screen API, and real XTEST synthetic input. Nothing here can be
 * satisfied by editing a config file.
 *
 * SKIP SEMANTICS ARE THE POINT
 * ----------------------------
 * Contract §10 and this repo's own convention are that a suite which could not
 * run must never look like a pass. When Docker or the image is missing, every
 * test below is `it.skip` and a loud banner is printed. When Docker IS present
 * the suite really runs, and a container that fails to boot is a FAILURE, never
 * a skip — because at that point the thing we needed was available and the
 * answer is genuinely bad news.
 *
 * Baseline before this file: `bun test` reported 790 pass / 1 skip. Both numbers
 * below are measured, not predicted (the second by pointing EZIL_VALIDATE_IMAGE
 * at an image that does not exist):
 *   - Docker + image present:  799 pass /  1 skip   (8 tests here + 1 more in
 *                              shell-scripts-parse.test.ts, whose whole-directory
 *                              sweep picks up validate-neko-browser-window.sh)
 *   - Docker or image absent:  791 pass /  9 skip
 * If the skip count moved from 1 to 9, this file is why — it is NOT a regression,
 * it is the suite correctly refusing to look green without a container.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const IMAGE = process.env.EZIL_VALIDATE_IMAGE ?? 'ezil-ground-truth:local';
const VALIDATOR = join(import.meta.dir, '..', 'scripts', 'validate-neko-browser-window.sh');
const CONTAINER = `ezil-w9-validate-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

/** Boot budget. The pinned build reaches `phase=ready status=ok` in ~11s. */
const BOOT_TIMEOUT_MS = 180_000;

function sh (cmd: string, args: string[], timeout = 60_000) {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout });
}

/**
 * Why this suite may not run. `null` means it CAN run.
 * Only a missing Docker daemon or a missing image is a legitimate skip.
 */
function unavailableReason (): string | null {
    const version = sh('docker', ['version', '--format', '{{.Server.Version}}'], 20_000);
    if (version.error || version.status !== 0) {
        return `the Docker daemon is not reachable (${(version.stderr || version.error?.message || '').trim().split('\n')[0]})`;
    }
    const image = sh('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], 20_000);
    if (image.status !== 0) {
        return `the image \`${IMAGE}\` is not present locally (build it with \`cd worker && docker build -t ${IMAGE} .\`)`;
    }
    return null;
}

interface Assertion {
    status: 'PASS' | 'FAIL' | 'SKIP';
    /** `now` = known-good on main, a FAIL is a regression. `awaiting:<agent>` = not landed yet. */
    cls: string;
    id: string;
    detail: string;
}

interface Run {
    exitCode: number;
    assertions: Assertion[];
    stderr: string;
}

const SKIP_REASON = unavailableReason();
let started = false;

function bootAndValidate (): Run {
    // No published port: the validator talks to neko on the container's own
    // loopback, so concurrent agents cannot collide on a host port.
    const run = sh('docker', [
        'run', '-d', '--name', CONTAINER, '--cpus=2',
        '-e', 'DESKTOP_MODE=neko',
        '-e', 'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=w9validate',
        '-e', 'NEKO_PASSWORD_ADMIN=w9validate',
        '-e', 'NEKO_MEMBER_MULTIUSER_USER_PASSWORD=w9user',
        '-e', 'NEKO_PASSWORD=w9user',
        '--entrypoint', '/bin/bash', IMAGE,
        '-c', 'DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh',
    ], 120_000);
    if (run.status !== 0) {
        throw new Error(`docker run failed: ${(run.stderr || '').trim()}`);
    }
    started = true;

    // Wait for start-neko.sh's own readiness line, not a fixed sleep.
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline) {
        const probe = sh('docker', ['exec', CONTAINER, 'grep', '-c', 'phase=ready', '/tmp/neko.log'], 20_000);
        if (probe.status === 0 && Number((probe.stdout || '0').trim()) > 0) { ready = true; break; }
        const alive = sh('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], 20_000);
        if ((alive.stdout || '').trim() !== 'true') {
            const logs = sh('docker', ['logs', '--tail', '40', CONTAINER], 20_000);
            throw new Error(`container exited before becoming ready:\n${logs.stdout}\n${logs.stderr}`);
        }
        Bun.sleepSync(1000);
    }
    if (!ready) throw new Error(`container never reached phase=ready within ${BOOT_TIMEOUT_MS}ms`);

    // Copy the validator from the worktree rather than relying on the image's
    // baked copy: the Dockerfile COPY for this NEW script does not exist yet
    // (see the report — it is a hook requested from W1), and copying also means
    // this suite always exercises the file in THIS checkout, not a stale layer.
    const cp = sh('docker', ['cp', VALIDATOR, `${CONTAINER}:/usr/local/bin/validate-neko-browser-window.sh`], 30_000);
    if (cp.status !== 0) throw new Error(`docker cp failed: ${(cp.stderr || '').trim()}`);

    const res = sh('docker', [
        'exec', CONTAINER, 'bash', '/usr/local/bin/validate-neko-browser-window.sh',
    ], 240_000);

    const assertions: Assertion[] = (res.stdout || '')
        .split('\n')
        .filter((l) => l.startsWith('ASSERT\t'))
        .map((l) => {
            const [, status, cls, id, ...rest] = l.split('\t');
            return { status: status as Assertion['status'], cls, id, detail: rest.join('\t') };
        });

    return { exitCode: res.status ?? -1, assertions, stderr: res.stderr || '' };
}

let result: Run | null = null;
let bootError: string | null = null;

if (SKIP_REASON) {
    // LOUD. A skipped container suite must never be mistaken for a green one.
    console.warn(
        `\n${'='.repeat(78)}\n` +
        `SKIPPING the neko browser-window container suite: ${SKIP_REASON}.\n` +
        `Nothing about the browser window, screen modes, or XTEST input has been\n` +
        `verified by this run. These behaviours are ONLY provable in a container.\n` +
        `${'='.repeat(78)}\n`,
    );
} else {
    try {
        result = bootAndValidate();
    } catch (err) {
        bootError = err instanceof Error ? err.message : String(err);
    }
}

afterAll(() => {
    if (started) sh('docker', ['rm', '-f', CONTAINER], 60_000);
});

const itIfContainer = SKIP_REASON ? it.skip : it;

/** Assertion ids that a named agent has not landed yet. */
const AWAITING_OWNERS: Record<string, string> = {
    'browser.chrome_frame.no_caption_buttons': 'W3 (seed browser.custom_chrome_frame=false)',
    'screen.resize.portrait': 'W1 (raise the framebuffer to 1920x1920x24)',
};

function byId (id: string): Assertion | undefined {
    return result?.assertions.find((a) => a.id === id);
}

function expectPass (id: string) {
    const a = byId(id);
    expect(`${id}: ${a ? `${a.status} — ${a.detail}` : 'ASSERTION NOT EMITTED AT ALL'}`)
        .toBe(`${id}: PASS — ${a?.detail}`);
}

describe('neko browser window (real container)', () => {
    itIfContainer('the container booted and the validator ran to completion', () => {
        expect(bootError).toBeNull();
        // A vacuous run — zero assertions parsed — must never look like a pass.
        expect(result?.assertions.length ?? 0).toBeGreaterThan(14);
    });

    itIfContainer('every assertion actually ran (a SKIP inside the validator is UNPROVEN, not passing)', () => {
        const skipped = (result?.assertions ?? []).filter((a) => a.status === 'SKIP');
        expect(skipped.map((a) => `${a.id}: ${a.detail}`)).toEqual([]);
    });

    itIfContainer('no `now`-class assertion failed (a failure here is a real regression)', () => {
        const regressions = (result?.assertions ?? [])
            .filter((a) => a.status === 'FAIL' && a.cls === 'now')
            .map((a) => `${a.id}: ${a.detail}`);
        expect(regressions).toEqual([]);
        // exit 1 is reserved for exactly this condition.
        expect(result?.exitCode).not.toBe(1);
    });

    itIfContainer('the browser window is genuinely undecorated (X properties + real frame geometry)', () => {
        // Three independent runtime signals, per docs/NEKO-GROUND-TRUTH.md §b.
        // None of these can be satisfied by the XML containing the word `decor`.
        expectPass('browser.undecorated.frame_extents');   // _NET_FRAME_EXTENTS == 0,0,0,0
        expectPass('browser.undecorated.ob_state');        // _OB_WM_STATE_UNDECORATED in _NET_WM_STATE
        expectPass('browser.undecorated.frame_geometry');  // openbox frame == client, pixel for pixel
    });

    itIfContainer('the literal WM_CLASS is recorded and is what the openbox rule targets', () => {
        const literal = byId('browser.wmclass.literal');
        expect(literal?.status).toBe('PASS');
        // Recorded verbatim so the class string is never again an open question.
        expect(literal?.detail).toContain("class='Google-chrome'");
        // The rule set is read from the config the RUNNING openbox actually
        // loaded (resolved from its argv), and compared to the live window's
        // class. This is the check whose absence made the decoration question
        // unanswerable — a `<decor>no</decor>` rule targeting a class no window
        // has is now a hard failure instead of a silent no-op.
        expectPass('openbox.decor_rule.targets');
        expectPass('openbox.matched_class');
    });

    itIfContainer('the screen API really resizes, and really refuses a mode above the framebuffer', () => {
        expectPass('xserver.framebuffer');            // ceiling read from the X server's own argv
        expectPass('screen.configurations');
        expectPass('screen.resize.downward');         // xdpyinfo AND the Chrome window both followed
        expectPass('screen.resize.oversize_refused'); // the negative case matters as much as the positive
        expectPass('screen.restore');                 // contract §3: always end up back at 1920x1080
    });

    itIfContainer('XTEST synthetic input really reaches the browser', () => {
        // Ground truth §f proved this by hand; this makes it standing coverage so
        // a future change cannot silently break input the way it silently sat
        // "UNVERIFIED" in a comment for a long time.
        expectPass('xtest.input_focus');
        expectPass('xtest.pointer_warp');        // XTEST motion accepted by the X server
        expectPass('xtest.keyboard_to_browser'); // Ctrl+T changed the real window title
        expectPass('xtest.pointer_to_browser');  // a click on the tab strip switched tabs
        expectPass('xtest.restored');            // and it put the browser back
    });

    itIfContainer('the only red assertions are ones a named agent has not landed yet', () => {
        const pending = (result?.assertions ?? [])
            .filter((a) => a.status === 'FAIL' && a.cls.startsWith('awaiting:'))
            .map((a) => a.id);

        // No NEW pending item may appear. A red assertion that nobody owns is a
        // regression, not a pending fix.
        const unowned = pending.filter((id) => !(id in AWAITING_OWNERS));
        expect(unowned).toEqual([]);

        for (const id of pending) {
            console.warn(`STILL PENDING — ${id} is red, owned by ${AWAITING_OWNERS[id]}`);
        }
        // TIGHTEN ME. When an entry stops appearing here its fix has landed;
        // delete it from AWAITING_OWNERS so it becomes a hard `now` assertion and
        // can never quietly regress. Phase 2 must empty this map.
        for (const id of Object.keys(AWAITING_OWNERS)) {
            if (!pending.includes(id)) {
                console.warn(
                    `LANDED — ${id} now passes (${AWAITING_OWNERS[id]}). ` +
                    `Remove it from AWAITING_OWNERS in this file and from the awaiting:* ` +
                    `class in validate-neko-browser-window.sh so it is enforced from now on.`,
                );
            }
        }

        // 0 = all green, 2 = only awaiting:* are red. 1 (regression) and
        // 3 (an assertion could not run) are both hard failures.
        expect([0, 2]).toContain(result?.exitCode);
    });
});
