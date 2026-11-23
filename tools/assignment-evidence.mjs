#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    closeSync, constants, createReadStream, createWriteStream, fstatSync, lstatSync,
    mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

const usage = [
    'Usage: node tools/assignment-evidence.mjs',
    '  --repo <worktree> --out <new-directory-outside-repo>',
    '  --attempt-id <id> --assignment-version <version> --base-sha <full-sha>',
    '  --phase <baseline|manual|agent|submission|interrupted>',
    '  [--remote-ref refs/heads/<branch>] [--submitted-sha <full-sha>]',
    '  [--attach <chat|ai-trace|gateway|tests|preview|comments|workspace>=<file>]...',
    '  [--observe <kind>=<UTC-timestamp>]...',
].join('\n');

const required = ['repo', 'out', 'attempt-id', 'assignment-version', 'base-sha', 'phase'];
const scalar = new Set([...required, 'remote-ref', 'submitted-sha']);
const phases = new Set(['baseline', 'manual', 'agent', 'submission', 'interrupted']);
const attachmentKinds = new Set(['chat', 'ai-trace', 'gateway', 'tests', 'preview', 'comments', 'workspace']);
const label = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

class CaptureError extends Error {}

function requireValue(condition, message) {
    if (!condition) throw new CaptureError(message);
}

function parseArguments(args) {
    const values = new Map();
    const attachments = [];
    const observations = [];
    for (let i = 0; i < args.length; i += 2) {
        const flag = args[i];
        const key = flag.slice(2);
        const value = args[i + 1];
        requireValue(flag.startsWith('--') && (scalar.has(key) || key === 'attach' || key === 'observe'),
            'Unknown option. Run with --help for usage.');
        requireValue(value && !value.startsWith('--'), 'An option is missing its value.');
        if (scalar.has(key)) {
            requireValue(!values.has(key), 'A single-use option was supplied more than once.');
            values.set(key, value);
            continue;
        }
        const split = value.indexOf('=');
        requireValue(split > 0 && split < value.length - 1, 'Expected kind=value for --attach or --observe.');
        const kind = value.slice(0, split);
        const entry = value.slice(split + 1);
        if (key === 'attach') {
            requireValue(attachmentKinds.has(kind), 'Unsupported attachment kind.');
            attachments.push({ kind, source: entry });
        } else {
            const time = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(entry);
            requireValue(label.test(kind) && time && Number.isFinite(Date.parse(entry))
                && new Date(entry).toISOString() === time[1] + '.' + (time[2] ?? '').padEnd(3, '0') + 'Z',
            'Invalid observation. Use an event label and a valid UTC timestamp ending in Z.');
            observations.push({ kind, at: entry });
        }
    }
    for (const name of required) requireValue(values.has(name), 'Missing --' + name + '.');
    const attemptId = values.get('attempt-id');
    const assignmentVersion = values.get('assignment-version');
    const phase = values.get('phase');
    requireValue(label.test(attemptId) && label.test(assignmentVersion), 'Invalid attempt ID or assignment version.');
    requireValue(phases.has(phase), 'Invalid capture phase.');
    return { values, attemptId, assignmentVersion, phase, attachments, observations };
}

const gitEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
};
for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_PARAMETERS', 'GIT_NAMESPACE']) {
    delete gitEnv[name];
}

function git(repo, args, { stdout = 'pipe', timeout, config = [], network = false } = {}) {
    return spawnSync('git', ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
        '-c', 'submodule.recurse=false', ...config.flatMap(value => ['-c', value]), '-C', repo, ...args], {
        env: network ? gitEnv : { ...gitEnv, GIT_ALLOW_PROTOCOL: '' },
        stdio: ['ignore', stdout, 'ignore'],
        encoding: 'utf8',
        timeout,
        killSignal: 'SIGKILL',
    });
}

function readGit(repo, args, operation) {
    const result = git(repo, args);
    requireValue(result.status === 0, 'Git could not ' + operation + '.');
    return result.stdout.replace(/\r?\n$/, '');
}

function isWithin(root, candidate) {
    const remainder = relative(root, candidate);
    return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith('..' + sep));
}

function commitSha(repo, input, option, shaPattern) {
    requireValue(shaPattern.test(input), 'Expected a full commit SHA for --' + option + '.');
    const sha = input.toLowerCase();
    requireValue(readGit(repo, ['cat-file', '-t', sha], 'resolve --' + option) === 'commit',
        '--' + option + ' must identify a commit.');
    return sha;
}

function remoteEvidence(repo, ref, headSha, submittedSha, shaPattern) {
    if (!ref) return { ref: null, headSha: null, status: 'not-checked', submittedSha, checkedAt: null };
    const result = git(repo, ['ls-remote', '--exit-code', '--refs', 'origin', ref], { timeout: 10000, network: true });
    const checkedAt = new Date().toISOString();
    const sha = result.status === 0 ? result.stdout.split('\n').map(line => line.split('\t'))
        .find(([value, name]) => name === ref && shaPattern.test(value))?.[0].toLowerCase() : null;
    const remoteHead = sha ?? null;
    const status = remoteHead === null ? 'unavailable' : remoteHead === (submittedSha ?? headSha) ? 'match' : 'mismatch';
    return { ref, headSha: remoteHead, status, submittedSha, checkedAt };
}

async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

async function copyAttachment(source, destination) {
    let fd;
    try {
        fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        requireValue(fstatSync(fd).isFile(), 'An attachment is not a regular file.');
        const input = createReadStream(source, { fd });
        fd = undefined;
        await pipeline(input, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    } catch {
        throw new CaptureError('Could not copy an attachment. Use readable regular files.');
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function captureGit(repo, artifactsDir, baseSha, headSha) {
    // Worktree reads must not execute a configured clean filter. Index and
    // committed objects already contain the bytes that Git recorded.
    const filters = git(repo, ['config', '--null', '--name-only', '--get-regexp', /^filter\..*\.(clean|process|required)$/.source]);
    requireValue(filters.status === 0 || filters.status === 1, 'Git could not read filter configuration.');
    const filterNames = new Set(filters.stdout.split('\0').filter(Boolean).map(key => key.slice(0, key.lastIndexOf('.'))));
    requireValue([...filterNames].every(name => !name.includes('=')), 'Unsupported Git filter configuration.');
    const config = [...filterNames].flatMap(name => [name + '.clean=', name + '.process=', name + '.required=false']);
    const diff = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--binary',
        '--full-index', '--find-renames', '--submodule=short', '--ignore-submodules=dirty',
        '--src-prefix=a/', '--dst-prefix=b/'];
    const artifacts = [
        ['status.txt', ['status', '--porcelain=v1', '--branch', '--untracked-files=all', '--ignore-submodules=dirty']],
        ['commits.txt', ['log', '--no-decorate', '--no-show-signature', '--format=raw', baseSha + '..' + headSha, '--']],
        ['committed.patch', [...diff, baseSha, headSha, '--']],
        ['staged.patch', [...diff, '--cached', headSha, '--']],
        ['unstaged.patch', [...diff, '--']],
    ];
    for (const [path, args] of artifacts) {
        const fd = openSync(join(artifactsDir, path), 'wx', 0o600);
        try {
            requireValue(git(repo, args, { stdout: fd, config }).status === 0, 'Git could not write ' + path + '.');
        } finally {
            closeSync(fd);
        }
    }
    return artifacts.map(([path]) => path);
}

async function capture(options) {
    const { values, attemptId, assignmentVersion, phase, attachments, observations } = options;
    const folder = resolve(values.get('repo'));
    const repo = realpathSync(readGit(folder, ['rev-parse', '--show-toplevel'], 'find the worktree'));
    const gitDir = readGit(repo, ['rev-parse', '--absolute-git-dir'], 'find the Git directory');
    const commonDir = readGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 'find the Git common directory');
    const format = readGit(repo, ['rev-parse', '--show-object-format'], 'read the object format');
    requireValue(format === 'sha1' || format === 'sha256', 'Unsupported Git object format.');
    const shaPattern = new RegExp('^[0-9a-fA-F]{' + (format === 'sha256' ? 64 : 40) + '}$');
    const headSha = readGit(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], 'read HEAD');
    const baseSha = commitSha(repo, values.get('base-sha'), 'base-sha', shaPattern);
    requireValue(git(repo, ['merge-base', '--is-ancestor', baseSha, headSha]).status === 0,
        'The base commit must be an ancestor of HEAD.');
    const submittedSha = values.has('submitted-sha')
        ? commitSha(repo, values.get('submitted-sha'), 'submitted-sha', shaPattern) : null;
    const ref = values.get('remote-ref') ?? null;
    requireValue(ref === null || (ref.startsWith('refs/heads/') && git(repo, ['check-ref-format', ref]).status === 0),
        'Expected a full branch ref under refs/heads/.');

    const requested = resolve(values.get('out'));
    const parent = realpathSync(dirname(requested));
    const destination = join(parent, basename(requested));
    requireValue([repo, gitDir, commonDir].every(root => !isWithin(realpathSync(root), destination)),
        'The evidence destination must be outside the worktree and Git directories.');
    requireValue(!lstatSync(destination, { throwIfNoEntry: false }), 'The evidence destination already exists.');
    const lock = join(parent, '.assignment-evidence-' + createHash('sha256').update(destination).digest('hex') + '.lock');
    try {
        mkdirSync(lock, { mode: 0o700 });
    } catch {
        throw new CaptureError('Could not reserve the evidence destination. It may be in use.');
    }

    let temporary;
    try {
        requireValue(!lstatSync(destination, { throwIfNoEntry: false }), 'The evidence destination already exists.');
        temporary = mkdtempSync(join(parent, '.assignment-evidence-'));
        const capturedAt = new Date().toISOString();
        const paths = captureGit(repo, temporary, baseSha, headSha);
        requireValue(headSha === readGit(repo, ['rev-parse', '--verify', 'HEAD^{commit}'], 'recheck HEAD'),
            'HEAD changed during capture. Retry from a stable worktree.');

        const copied = [];
        if (attachments.length) mkdirSync(join(temporary, 'attachments'), { mode: 0o700 });
        for (const [index, { kind, source }] of attachments.entries()) {
            const path = 'attachments/' + (index + 1) + '-' + kind;
            const file = join(temporary, path);
            await copyAttachment(source, file);
            copied.push({ kind, path, sha256: await sha256(file) });
        }

        const artifacts = await Promise.all(paths.map(async path => ({
            path, sha256: await sha256(join(temporary, path)),
        })));
        const remote = remoteEvidence(repo, ref, headSha, submittedSha, shaPattern);
        const manifest = {
            schemaVersion: 1, attemptId, assignmentVersion, phase, capturedAt,
            baseSha, headSha, remote, observations, artifacts, attachments: copied,
        };
        writeFileSync(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n',
            { flag: 'wx', mode: 0o600 });
        requireValue(!lstatSync(destination, { throwIfNoEntry: false }), 'The evidence destination already exists.');
        renameSync(temporary, destination);
        temporary = undefined;
    } finally {
        if (temporary) rmSync(temporary, { recursive: true, force: true });
        rmSync(lock, { force: true, recursive: true });
    }
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(usage + '\n');
} else {
    try {
        await capture(parseArguments(args));
        process.stdout.write('Evidence snapshot captured.\n');
    } catch (error) {
        const message = error instanceof CaptureError ? error.message
            : 'Could not capture evidence. Check the worktree, destination parent, and filesystem permissions.';
        process.stderr.write(message + '\n');
        process.exitCode = 1;
    }
}
