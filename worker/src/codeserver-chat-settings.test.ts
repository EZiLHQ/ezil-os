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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

function runCodeserverBlock (dir: string): { code: number | null; stderr: string } {
    const script = `set -euo pipefail\nUSER_DATA_DIR="$1"\n${codeserverChatBlock()}\n`;
    const r = spawnSync('bash', ['-c', script, 'bash', dir], { encoding: 'utf8' });
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
    'workbench.secondarySideBar.defaultVisibility': 'visible',
    'ezilChat.autoStart': false,
    'ezilChat.revealOnStartup': false,
};

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
