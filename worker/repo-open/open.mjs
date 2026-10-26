import { createHash } from 'node:crypto';
import { lstat, realpath, mkdir, readFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { validateGrant } from './grant.mjs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const supervisor = fileURLToPath(new URL('./supervise.py', import.meta.url));
export const execute = (cli, args, { timeout, grace = 3000, privateGrant, ...options }) => {
    if (privateGrant === undefined) return exec('/usr/bin/python3', [supervisor, String(timeout), String(grace), cli, ...args], options);
    return new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/python3', [supervisor, String(timeout), String(grace), cli, ...args, '--grant-fd=3'],
            { ...options, stdio: ['ignore', 'pipe', 'ignore', 'pipe'] });
        let stdout = '';
        child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
        child.stdio[3].on('error', () => {}); // early refusal may close the private input
        child.stdio[3].end(JSON.stringify(privateGrant));
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve({ stdout }) : reject(Object.assign(new Error('repo operation failed'), { code, stdout })));
    });
};
const canonical = /^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/(?![a-z0-9._-]*\.\.)(?![a-z0-9._-]*\.git\.git$)[a-z0-9][a-z0-9._-]{0,99}\.git$/;
export function validateIntent(input) {
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !['repo', 'userId', 'grant'].includes(k))
        || typeof input.repo !== 'string' || !canonical.test(input.repo)
        || typeof input.userId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.userId)) throw new Error('repo_invalid_request');
    if (input.grant !== undefined) validateGrant(input.grant, input.repo);
    return input;
}
async function safeDirectory(path, create = false) {
    if (create) await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('repo_unsafe_destination');
}
export async function openRepository(input, { root = process.env.EZIL_WORKSPACE_ROOT, cli = '/opt/ezil-cli/ezil', run = execute, verifyPin = true, timeoutMs = 180000 } = {}) {
    const { repo, userId, grant } = validateIntent(input);
    if (!root || !root.startsWith('/') || resolve(root) !== root) throw new Error('repo_workspace_unavailable');
    await safeDirectory(root);
    // Each ancestor is checked before descending: recursive mkdir must not follow a hostile parent.
    let parent = root;
    for (const name of ['.ezil-repositories', createHash('sha256').update(userId).digest('hex')]) {
        parent = join(parent, name);
        await safeDirectory(parent, true);
    }
    const folder = join(parent, createHash('sha256').update(repo).digest('hex'));
    try { await safeDirectory(folder); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (verifyPin) {
        try {
            const pin = JSON.parse(await readFile('/opt/ezil-cli/pin.json', 'utf8'));
            const digest = createHash('sha256').update(await readFile(cli)).digest('hex');
            if (!pin.version || digest !== pin.sha256) throw new Error();
        } catch { throw new Error('repo_cli_unavailable'); }
    }
    let result;
    try {
        const { stdout } = await run(cli, ['clone', repo, '--directory', folder, '--json'], { timeout: timeoutMs, maxBuffer: 65536, shell: false, ...(grant === undefined ? {} : { privateGrant: grant }) });
        result = JSON.parse(stdout);
    } catch (error) {
        if (error.code === 126) throw new Error('repo_recovery_required');
        if (error.code === 124) throw new Error('repo_timeout');
        let code;
        try { code = JSON.parse(error.stdout).error?.code; } catch { /* No raw output escapes. */ }
        throw new Error(code === 'auth-required' ? 'repo_auth_required' : code === 'repository-not-authorized' ? 'repo_not_authorized' : 'repo_clone_failed');
    }
    if (result?.canonicalUrl !== repo || result.folder !== folder || (grant ? result.identity?.issuer !== grant.identity.issuer || result.identity?.subject !== grant.identity.subject : typeof result.accountId !== 'string' || !result.accountId)
        || !['cloned', 'reused'].includes(result.status)) throw new Error('repo_invalid_result');
    await safeDirectory(folder);
    if (!folder.startsWith(root + sep)) throw new Error('repo_unsafe_destination');
    return { ok: true, folder, canonicalUrl: repo, status: result.status };
}
