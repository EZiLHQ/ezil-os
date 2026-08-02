/**
 * THE ENUM RECONCILIATION, MECHANISED.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * Three Wave A tasks touched app focus without seeing each other:
 *
 *   - the Worker task built `POST /sandbox/:id/focus { app: 'vscode' | 'chromium' }`
 *     and exec'd `/usr/local/bin/neko-switch-app.sh <app>`;
 *   - the container task REPLACED Electron VS Code with code-server, which is
 *     an HTTP server on 127.0.0.1:8443 and not an X client, so `vscode` can
 *     never resolve a window again;
 *   - the shell task built a two-button switcher offering both.
 *
 * Each was right. Composed, "VS Code" was a button guaranteed to fail — the
 * same defect the container task deleted from `ebuilder-menu.xml` ("Focus VS
 * Code"), reintroduced one layer up.
 *
 * ── Why this test is not just `expect(FOCUSABLE_APPS).toEqual(['chromium'])` ─
 * That assertion pins today's answer and teaches nothing. It would keep
 * passing if someone re-added Electron VS Code to the image (and then the
 * product would be missing a control that works), and it would keep passing if
 * someone swapped Chromium out (and then the product would ship a control that
 * cannot work). Both are the SAME bug — the app layer disagreeing with the
 * image about what has an X window — and a literal comparison catches neither.
 *
 * So this reads the two container artifacts that actually decide the answer
 * and checks the enum against them, in BOTH directions:
 *
 *   `worker/scripts/start-neko.sh`  ->  EZIL_DESKTOP_APPS, the image's own
 *                                       declaration of which apps it ships
 *                                       and which of those are X windows
 *                                       (`kind` = `window`) vs plain listening
 *                                       ports (`kind` = `tcp`);
 *   `neko-switch-app.sh` (heredoc'd in the same file) -> the WM_CLASS regex
 *                                       each focus id resolves by.
 *
 * If the image changes, this fails and names what changed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FOCUSABLE_APPS, isFocusableApp } from './cloudflare-guacamole-provider';

const START_NEKO = fileURLToPath(new URL('../../../../worker/scripts/start-neko.sh', import.meta.url));
const DOCKERFILE = fileURLToPath(new URL('../../../../worker/Dockerfile', import.meta.url));

const startNeko = readFileSync(START_NEKO, 'utf8');

/**
 * The `case` arms of the heredoc'd `neko-switch-app.sh`: focus id -> the
 * WM_CLASS regex it matches with. Parsed rather than duplicated, so a renamed
 * id or a changed regex shows up here as a failure and not as a silent
 * divergence.
 */
function parseSwitchAppArms(): Map<string, string> {
    const arms = new Map<string, string>();
    // e.g.  `  vscode)   class_re='(^|\.)code(\.|$)|Code' ;;`
    const re = /^\s*([a-z0-9_-]+)\)\s*class_re='([^']*)'/gim;
    let m: RegExpExecArray | null;
    while ((m = re.exec(startNeko)) !== null) {
        arms.set(m[1]!, m[2]!);
    }
    return arms;
}

/**
 * The default value of `EZIL_DESKTOP_APPS` — the image's own statement of the
 * mandatory app set, as `name:kind:target` triples. `kind` is `window` (an X
 * client, resolvable by WM_CLASS and therefore focusable) or `tcp` (a
 * listening port, which by definition has no window to raise).
 */
function parseDesktopApps(): { name: string; kind: string; target: string }[] {
    // Anchored to the whole assignment line rather than stopping at the first
    // `}`, because the default now interpolates `${CODE_SERVER_PORT}` — the
    // script's single source of truth for code-server's port, shared by the
    // launch flag, this readiness declaration and the stale-listener preflight.
    // Resolving that variable from its own default in the same file keeps the
    // port un-hardcoded HERE too, so this still fails (rather than silently
    // drifting) if the image ever moves code-server off 8443.
    const m = /^EZIL_DESKTOP_APPS="\$\{EZIL_DESKTOP_APPS:-(.*)\}"$/m.exec(startNeko);
    expect(m, 'EZIL_DESKTOP_APPS default not found in start-neko.sh').toBeTruthy();
    const portM = /^CODE_SERVER_PORT="\$\{CODE_SERVER_PORT:-(\d+)\}"$/m.exec(startNeko);
    expect(portM, 'CODE_SERVER_PORT default not found in start-neko.sh').toBeTruthy();
    return m![1]!
        .replaceAll('${CODE_SERVER_PORT}', portM![1]!)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((spec) => {
            const first = spec.indexOf(':');
            const second = spec.indexOf(':', first + 1);
            return {
                name: spec.slice(0, first),
                kind: spec.slice(first + 1, second),
                // The target may itself contain a colon (`127.0.0.1:8443`).
                target: spec.slice(second + 1),
            };
        });
}

/** How `neko-switch-app.sh` matches: `tolower($3) ~ tolower(re)` in awk. */
function classMatches(classRe: string, wmClass: string): boolean {
    try {
        return new RegExp(classRe, 'i').test(wmClass);
    } catch {
        return false;
    }
}

describe('FOCUSABLE_APPS agrees with the container image about what has an X window', () => {
    it('parsed the two container artifacts it reasons from', () => {
        const arms = parseSwitchAppArms();
        const apps = parseDesktopApps();
        // A parse that silently found nothing would make every check below
        // vacuously pass. Treat an empty result as broken infrastructure.
        expect(arms.size).toBeGreaterThan(0);
        expect(apps.length).toBeGreaterThan(0);
        expect(apps.some((a) => a.kind === 'window')).toBe(true);
    });

    it('every app this product offers to focus HAS an X window in the shipped image', () => {
        const arms = parseSwitchAppArms();
        const windows = parseDesktopApps().filter((a) => a.kind === 'window');

        for (const app of FOCUSABLE_APPS) {
            const classRe = arms.get(app);
            expect(classRe, `neko-switch-app.sh has no case arm for "${app}"`).toBeTruthy();
            const matched = windows.some((w) => classMatches(classRe!, w.target));
            expect(
                matched,
                `FOCUSABLE_APPS offers "${app}" (class ~ ${classRe}) but no window-kind app in `
                    + `EZIL_DESKTOP_APPS matches it — that control would fail 100% of the time`,
            ).toBe(true);
        }
    });

    it('🔴 no app WITHOUT an X window is offered — the "Focus VS Code" defect, mechanised', () => {
        const arms = parseSwitchAppArms();
        const windows = parseDesktopApps().filter((a) => a.kind === 'window');

        for (const [app, classRe] of arms) {
            const hasWindow = windows.some((w) => classMatches(classRe, w.target));
            if (!hasWindow) {
                expect(
                    isFocusableApp(app),
                    `"${app}" resolves no window in this image (class ~ ${classRe}); it must NOT be in `
                        + 'FOCUSABLE_APPS or the UI ships a control that always errors',
                ).toBe(false);
            }
        }
    });

    it('specifically: `vscode` is not offered, because code-server is not an X client', () => {
        // The narrow, literal statement of today's answer — kept alongside the
        // general rules above so a failure reads as "this changed" rather than
        // sending the reader to parse two shell scripts.
        expect(isFocusableApp('vscode')).toBe(false);
        expect(isFocusableApp('chromium')).toBe(true);
        // The image really did drop Electron VS Code: nothing copies it in.
        expect(readFileSync(DOCKERFILE, 'utf8')).not.toMatch(/COPY\s+--from=neko\s+\/usr\/share\/code/);
        // …and code-server really is a port, not a window.
        expect(parseDesktopApps().find((a) => a.name === 'codeserver')?.kind).toBe('tcp');
    });

    it('rejects anything outside the enum, including the Worker’s still-legal `vscode`', () => {
        for (const bad of ['vscode', 'VSCODE', 'Chromium', 'chromium; rm -rf /', '', null, undefined, 7]) {
            expect(isFocusableApp(bad)).toBe(false);
        }
    });
});
