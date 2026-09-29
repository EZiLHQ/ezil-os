/**
 * The bundled Copilot Chat must open on EZiL models with NO GitHub sign-in.
 *
 * Measured in code-server 4.139.1 (Code 1.139.1, GitHub.copilot-chat 0.67.0,
 * /workspace/copilot-byok-test/REPORT.md): on a cold browser profile the
 * core disables the copilot-chat extension until "chat setup" completes, a
 * third-party `LanguageModelChatProvider` is never queried, and submitting a
 * prompt pops "Sign in to use GitHub Copilot". Two boot-time files change
 * that, and both are written by the launchers before code-server starts:
 *
 *   <user-data-dir>/Machine/settings.json      `chat.allowAnonymousAccess: true` (+ the
 *                                              sign-in / completions / utility-model keys)
 *   <user-data-dir>/User/chatLanguageModels.json  `[{"name":"EZiL","vendor":"ezil"}]`, the
 *                                              group that flips `github.copilot.hasByokModels`
 *
 * These tests EXECUTE the shipped shell out of both launchers against temp
 * directories (same approach as codeserver-workspace-trust.test.ts) rather
 * than grepping for strings, and they pin the two launchers to each other:
 * start-codeserver.sh is the on-demand fallback and has drifted from
 * start-neko.sh before.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPTS = join(import.meta.dir, '..', 'scripts');
const START_NEKO = join(SCRIPTS, 'start-neko.sh');
const START_CODESERVER = join(SCRIPTS, 'start-codeserver.sh');
const neko = readFileSync(START_NEKO, 'utf8');
const codeserver = readFileSync(START_CODESERVER, 'utf8');

const tmp = (): string => mkdtempSync(join(tmpdir(), 'cs-chat-'));
const machinePath = (dir: string): string => join(dir, 'Machine', 'settings.json');
const groupsPath = (dir: string): string => join(dir, 'User', 'chatLanguageModels.json');
const userPath = (dir: string): string => join(dir, 'User', 'settings.json');

/** Brace-match a `name() { ... }` definition out of start-neko.sh so the test runs it verbatim. */
function extractFunction (src: string, name: string): string {
    const start = src.indexOf(`${name}() {`);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let i = src.indexOf('{', start);
    const open = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0) break;
        }
    }
    expect(i).toBeLessThan(src.length);
    return `${name}() ${src.slice(open, i + 1)}`;
}

function runNekoFn (name: string, dir: string): { code: number | null; stderr: string } {
    const script = `set -uo pipefail\n${extractFunction(neko, name)}\n${name} "$1"\n`;
    const r = spawnSync('bash', ['-c', script, 'bash', dir], { encoding: 'utf8' });
    return { code: r.status, stderr: r.stderr };
}

/** The body of a quoted heredoc (`<<'TAG'` ... `TAG`), first occurrence. */
function heredoc (src: string, tag: string): string {
    const open = src.indexOf(`<<'${tag}'\n`);
    expect(open).toBeGreaterThan(-1);
    const start = open + `<<'${tag}'\n`.length;
    const end = src.indexOf(`\n${tag}\n`, start);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end + 1);
}

/** start-codeserver.sh's inline block, delimited by its own markers, run as-is. */
function codeserverChatBlock (): string {
    const start = codeserver.indexOf('# >>> chat-ui-seed');
    const end = codeserver.indexOf('# <<< chat-ui-seed');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return codeserver.slice(start, end);
}

function runCodeserverBlock (dir: string, hostsFile = join(dir, 'hosts')): { code: number | null; stderr: string } {
    // The block also runs seed_blocked_ai_hosts; point it at a scratch file so a
    // root test runner never edits the real /etc/hosts.
    writeFileSync(hostsFile, '127.0.0.1\tlocalhost\n');
    const script = `set -euo pipefail\nUSER_DATA_DIR="$1"\nexport EZIL_HOSTS_FILE="$2"\n${codeserverChatBlock()}\n`;
    const r = spawnSync('bash', ['-c', script, 'bash', dir, hostsFile], { encoding: 'utf8' });
    return { code: r.status, stderr: r.stderr };
}

function runHostsFn (src: string, hostsFile: string): { code: number | null; stderr: string } {
    const script = `set -uo pipefail\nexport EZIL_HOSTS_FILE="$1"\n${extractFunction(src, 'seed_blocked_ai_hosts')}\nseed_blocked_ai_hosts\n`;
    const r = spawnSync('bash', ['-c', script, 'bash', hostsFile], { encoding: 'utf8' });
    return { code: r.status, stderr: r.stderr };
}

const EXPECTED_MACHINE: Record<string, unknown> = {
    'chat.disableAIFeatures': false,
    'chat.allowAnonymousAccess': true,
    'chat.byokUtilityModelDefault': 'mainAgent',
    'chat.titleBar.signIn.enabled': false,
    'chat.welcomePage.signIn.enabled': false,
    'github.copilot.enable': { '*': false },
    'github.copilot.nextEditSuggestions.enabled': false,
    // Revision 3: the extension's GitHub-only "Copilot CLI" / "Cloud" session
    // types are gated by these two keys; off, the session-target picker offers Local only.
    'github.copilot.chat.backgroundAgent.enabled': false,
    'github.copilot.chat.cloudAgent.enabled': false,
    // With BYOK models present the chat view shows its in-view "Sessions" list
    // instead of the welcome view; off, an empty chat shows the welcome (and its
    // EZiL notice) — sessions stay reachable via the view's toolbar/menu.
    'chat.viewSessions.enabled': false,
    'workbench.secondarySideBar.defaultVisibility': 'visible',
    'ezilChat.autoStart': false,
    'ezilChat.revealOnStartup': false,
};

/** Hosts the boot-time /etc/hosts block must map to loopback (revision 3, see PATCHES.md). */
const BLOCKED_AI_HOSTS = [
    'api.githubcopilot.com',
    'copilot-proxy.githubusercontent.com',
    'copilot-telemetry.githubusercontent.com',
    'default.exp-tas.com',
    'mobile.events.data.microsoft.com',
    'westus-0.in.applicationinsights.azure.com',
    'main.vscode-cdn.net',
    'embeddings.vscode-cdn.net',
];

describe('start-neko.sh Machine settings put Copilot Chat on EZiL models without sign-in', () => {
    it('writes valid JSON with exactly the keys the chat UI needs', () => {
        const dir = tmp();
        const { code, stderr } = runNekoFn('seed_codeserver_machine_settings', dir);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        // Must parse: code-server silently ignores a settings file it cannot
        // read, and the symptom would be a "Sign in to use GitHub Copilot" dialog.
        const parsed = JSON.parse(readFileSync(machinePath(dir), 'utf8')) as Record<string, unknown>;
        expect(parsed).toEqual(EXPECTED_MACHINE);
    });

    it('carries no application-scoped keys (the Machine layer drops them silently)', () => {
        const dir = tmp();
        runNekoFn('seed_codeserver_machine_settings', dir);
        const parsed = JSON.parse(readFileSync(machinePath(dir), 'utf8')) as Record<string, unknown>;
        expect(parsed).not.toHaveProperty('telemetry.telemetryLevel');
        expect(parsed).not.toHaveProperty('security.workspace.trust.enabled');
        // Anonymous mode forces Agent mode; a Plan default here would be dead config.
        expect(parsed).not.toHaveProperty('chat.newSession.defaultMode');
    });

    it('overwrites whatever a previous boot or a user left there', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'Machine'), { recursive: true });
        writeFileSync(machinePath(dir), '{"chat.disableAIFeatures": true, "chat.allowAnonymousAccess": false}');
        const { code } = runNekoFn('seed_codeserver_machine_settings', dir);
        expect(code).toBe(0);
        const parsed = JSON.parse(readFileSync(machinePath(dir), 'utf8')) as Record<string, unknown>;
        expect(parsed['chat.disableAIFeatures']).toBe(false);
        expect(parsed['chat.allowAnonymousAccess']).toBe(true);
    });

    it('is called, after the User seed and before code-server launches', () => {
        const userSeed = neko.indexOf('if seed_codeserver_user_settings "$CODE_SERVER_USER_DATA_DIR"');
        const machine = neko.indexOf('if seed_codeserver_machine_settings "$CODE_SERVER_USER_DATA_DIR"');
        const groups = neko.indexOf('if seed_codeserver_chat_models "$CODE_SERVER_USER_DATA_DIR"');
        const launch = neko.indexOf('supervise_app codeserver');
        expect(userSeed).toBeGreaterThan(-1);
        expect(machine).toBeGreaterThan(userSeed);
        expect(groups).toBeGreaterThan(machine);
        expect(launch).toBeGreaterThan(groups);
    });
});

describe('start-neko.sh seeds the ezil vendor group into chatLanguageModels.json', () => {
    it('creates the file (and User/) when absent', () => {
        const dir = join(tmp(), 'fresh', 'user-data');
        const { code, stderr } = runNekoFn('seed_codeserver_chat_models', dir);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        const groups = JSON.parse(readFileSync(groupsPath(dir), 'utf8')) as { name: string; vendor: string }[];
        expect(groups).toEqual([{ name: 'EZiL', vendor: 'ezil' }]);
    });

    it('leaves a file that already names the vendor untouched', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'User'), { recursive: true });
        const existing = '[{"name":"My EZiL","vendor":"ezil"}]';
        writeFileSync(groupsPath(dir), existing);
        const { code } = runNekoFn('seed_codeserver_chat_models', dir);
        expect(code).toBe(0);
        expect(readFileSync(groupsPath(dir), 'utf8')).toBe(existing);
    });

    it('merges into groups a user added through Manage Models instead of clobbering them', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'User'), { recursive: true });
        writeFileSync(groupsPath(dir), '[{"name":"My OpenAI","vendor":"openai","apiKey":"${input:chat.lm.secret.abc}"}]');
        const { code } = runNekoFn('seed_codeserver_chat_models', dir);
        expect(code).toBe(0);
        const groups = JSON.parse(readFileSync(groupsPath(dir), 'utf8')) as { name: string; vendor: string }[];
        expect(groups.map(g => g.vendor)).toEqual(['openai', 'ezil']);
        expect(groups[0]).toEqual({ name: 'My OpenAI', vendor: 'openai', apiKey: '${input:chat.lm.secret.abc}' });
    });

    it('recovers a file that is not valid JSON (VS Code would ignore it anyway)', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'User'), { recursive: true });
        writeFileSync(groupsPath(dir), '{ not json');
        const { code } = runNekoFn('seed_codeserver_chat_models', dir);
        expect(code).toBe(0);
        const groups = JSON.parse(readFileSync(groupsPath(dir), 'utf8')) as { vendor: string }[];
        expect(groups).toEqual([{ name: 'EZiL', vendor: 'ezil' }]);
    });
});

describe('start-neko.sh User seed turns telemetry off (application scope, so not in the Machine layer)', () => {
    it('writes telemetry.telemetryLevel off next to the trust setting', () => {
        const dir = tmp();
        const { code } = runNekoFn('seed_codeserver_user_settings', dir);
        expect(code).toBe(0);
        const parsed = JSON.parse(readFileSync(userPath(dir), 'utf8')) as Record<string, unknown>;
        expect(parsed['telemetry.telemetryLevel']).toBe('off');
        expect(parsed['security.workspace.trust.enabled']).toBe(false);
    });
});

describe('revision 3: the chat stack stays off GitHub at boot (belt and braces for the build-time patches)', () => {
    it('start-neko.sh maps the Copilot/telemetry-only hosts to loopback, idempotently, and never github.com', () => {
        const hosts = join(tmp(), 'hosts');
        writeFileSync(hosts, '127.0.0.1\tlocalhost\n172.17.0.2\tabc123\n');
        const first = runHostsFn(neko, hosts);
        expect(first.stderr).toBe('');
        expect(first.code).toBe(0);
        const once = readFileSync(hosts, 'utf8');
        for (const h of BLOCKED_AI_HOSTS) expect(once).toContain(`127.0.0.1 ${h}\n`);
        expect(once.startsWith('127.0.0.1\tlocalhost\n172.17.0.2\tabc123\n')).toBe(true);
        // developer tooling (git, gh, the PR extension) must keep resolving GitHub itself
        expect(once).not.toMatch(/^127\.0\.0\.1 (api\.)?github\.com$/m);
        expect(once).not.toMatch(/\bgithub\.com\b/);
        // second boot of the same container: no duplicate lines
        const second = runHostsFn(neko, hosts);
        expect(second.code).toBe(0);
        expect(readFileSync(hosts, 'utf8')).toBe(once);
    });

    it('returns non-zero (and writes nothing) when the hosts file is not writable, so boot goes on', () => {
        const dir = tmp();
        const hosts = join(dir, 'hosts');
        writeFileSync(hosts, '127.0.0.1\tlocalhost\n');
        chmodSync(hosts, 0o444);
        const { code } = runHostsFn(neko, hosts);
        if (process.getuid && process.getuid() === 0) {
            // root can write a 0444 file; the guard cannot be exercised here
            expect([0, 1]).toContain(code);
        } else {
            expect(code).toBe(1);
            expect(readFileSync(hosts, 'utf8')).toBe('127.0.0.1\tlocalhost\n');
        }
    });

    it('start-codeserver.sh carries the byte-identical function and runs it in its seed block', () => {
        expect(extractFunction(codeserver, 'seed_blocked_ai_hosts')).toBe(extractFunction(neko, 'seed_blocked_ai_hosts'));
        expect(heredoc(codeserver, 'EZIL_BLOCKED_AI_HOSTS')).toBe(heredoc(neko, 'EZIL_BLOCKED_AI_HOSTS'));
        const dir = tmp();
        const hosts = join(dir, 'hosts');
        const { code, stderr } = runCodeserverBlock(dir, hosts);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        const written = readFileSync(hosts, 'utf8');
        for (const h of BLOCKED_AI_HOSTS) expect(written).toContain(`127.0.0.1 ${h}\n`);
    });

    it('is called in start-neko.sh after the chat seeds and before code-server launches', () => {
        const groups = neko.indexOf('if seed_codeserver_chat_models "$CODE_SERVER_USER_DATA_DIR"');
        const hostsCall = neko.indexOf('if seed_blocked_ai_hosts; then');
        const launch = neko.indexOf('supervise_app codeserver');
        expect(hostsCall).toBeGreaterThan(groups);
        expect(launch).toBeGreaterThan(hostsCall);
    });

    it('both launchers pass --disable-update-check (code-server otherwise polls api.github.com for its latest release)', () => {
        const nekoLaunch = neko.slice(neko.indexOf('supervise_app codeserver'), neko.indexOf('phase_end codeserver_launch'));
        expect(nekoLaunch).toContain('--disable-update-check');
        expect(nekoLaunch).toContain('--disable-telemetry');
        const csLaunch = codeserver.slice(codeserver.indexOf('nohup code-server'), codeserver.indexOf('echo $! >"$PID_FILE"'));
        expect(csLaunch).toContain('--disable-update-check');
        expect(csLaunch).toContain('--disable-telemetry');
    });
});

describe('start-codeserver.sh mirrors both seeds', () => {
    it('ships a byte-identical Machine settings heredoc', () => {
        expect(heredoc(codeserver, 'CODESERVER_MACHINE_SETTINGS_JSON')).toBe(heredoc(neko, 'CODESERVER_MACHINE_SETTINGS_JSON'));
    });

    it('produces the same two files when run', () => {
        const dir = tmp();
        const { code, stderr } = runCodeserverBlock(dir);
        expect(stderr).toBe('');
        expect(code).toBe(0);
        expect(JSON.parse(readFileSync(machinePath(dir), 'utf8'))).toEqual(EXPECTED_MACHINE);
        expect(JSON.parse(readFileSync(groupsPath(dir), 'utf8'))).toEqual([{ name: 'EZiL', vendor: 'ezil' }]);
    });

    it('merges an existing group list the same way', () => {
        const dir = tmp();
        mkdirSync(join(dir, 'User'), { recursive: true });
        writeFileSync(groupsPath(dir), '[{"name":"Other","vendor":"anthropic"}]');
        const { code } = runCodeserverBlock(dir);
        expect(code).toBe(0);
        const groups = JSON.parse(readFileSync(groupsPath(dir), 'utf8')) as { vendor: string }[];
        expect(groups.map(g => g.vendor)).toEqual(['anthropic', 'ezil']);
    });

    it('seeds telemetry off in its User seed too, and runs before the launch', () => {
        expect(heredoc(codeserver, 'CODESERVER_SETTINGS_JSON')).toContain('"telemetry.telemetryLevel": "off"');
        const seed = codeserver.indexOf('# >>> chat-ui-seed');
        const launch = codeserver.indexOf('nohup code-server');
        expect(seed).toBeGreaterThan(-1);
        expect(launch).toBeGreaterThan(seed);
        expect(existsSync(START_CODESERVER)).toBe(true);
    });
});
