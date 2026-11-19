import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';

const phases = new Set(['baseline', 'manual', 'agent', 'submission', 'interrupted']);
const remoteStatuses = new Set(['not-checked', 'unavailable', 'match', 'mismatch']);
const attachmentKinds = new Set(['chat', 'ai-trace', 'gateway', 'tests', 'preview', 'comments', 'workspace']);
const gitArtifacts = ['status.txt', 'commits.txt', 'committed.patch', 'staged.patch', 'unstaged.patch'];
const sha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const firstOutputKinds = ['prompt-submitted', 'first-visible-output'];

function timestamp(value) {
    const match = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
    if (!match) return NaN;
    const date = new Date(value);
    const expected = `${match[1]}.${(match[2] ?? '').padEnd(3, '0')}Z`;
    return Number.isFinite(date.getTime()) && date.toISOString() === expected ? date.getTime() : NaN;
}

async function checkFile(directory, relativePath, checksum) {
    const target = join(directory, relativePath);
    if (!(await lstat(target)).isFile() || await realpath(target) !== target) {
        throw new Error(`Expected a regular bundle file at ${relativePath}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== checksum) throw new Error(`Checksum mismatch for ${relativePath}`);
}

function validateManifest(manifest) {
    const { remote, observations, artifacts, attachments } = manifest ?? {};
    if (manifest?.schemaVersion !== 1 || !matches(id, manifest.attemptId) ||
        !matches(id, manifest.assignmentVersion) || !phases.has(manifest.phase) ||
        !Number.isFinite(timestamp(manifest.capturedAt)) || !matches(sha, manifest.baseSha) ||
        !matches(sha, manifest.headSha) || !remoteStatuses.has(remote?.status) ||
        !Array.isArray(observations) || !Array.isArray(artifacts) || !Array.isArray(attachments)) {
        throw new Error('Invalid evidence manifest');
    }
    const { ref, headSha, status, submittedSha, checkedAt } = remote;
    const intendedSha = submittedSha ?? manifest.headSha;
    if ((submittedSha != null && !matches(sha, submittedSha)) ||
        (status === 'not-checked' ? checkedAt !== null : !Number.isFinite(timestamp(checkedAt))) ||
        (status === 'not-checked' ? ref !== null : !matches(/^refs\/heads\/.+$/, ref)) ||
        (status === 'match' || status === 'mismatch'
            ? !matches(sha, headSha) || (status === 'match') !== (headSha === intendedSha)
            : headSha !== null)) {
        throw new Error('Invalid remote evidence');
    }
    if (observations.some(item => !matches(id, item?.kind) || !Number.isFinite(timestamp(item.at)))) {
        throw new Error('Invalid milestone observation');
    }
    if (artifacts.length !== gitArtifacts.length || gitArtifacts.some(path => !artifacts.some(item => item?.path === path)) ||
        attachments.some(item => !attachmentKinds.has(item?.kind) ||
            !matches(/^attachments\/[A-Za-z0-9][A-Za-z0-9._-]*$/, item.path))) {
        throw new Error('Invalid evidence file list');
    }
    const files = [...artifacts, ...attachments];
    if (new Set(files.map(item => item.path)).size !== files.length || files.some(item => !matches(/^[a-f0-9]{64}$/, item.sha256))) {
        throw new Error('Invalid evidence file paths or checksums');
    }
    return files;
}

async function loadSnapshot(directory) {
    try {
        const path = join(directory, 'manifest.json');
        if (!(await lstat(path)).isFile()) throw new Error('Expected a regular manifest file');
        const manifest = JSON.parse(await readFile(path, 'utf8'));
        const files = validateManifest(manifest);
        for (const file of files) await checkFile(directory, file.path, file.sha256);
        return { ...manifest, snapshotDirectory: basename(directory) };
    } catch (error) {
        const reason = error.code === 'ENOENT' ? 'A manifest or evidence file is missing' : error.message;
        throw new Error(`${directory}: ${reason}`);
    }
}

function interval(observations, startKind, endKind, gaps) {
    const start = observations.get(startKind) ?? new Set();
    const end = observations.get(endKind) ?? new Set();
    if (start.size !== 1 || end.size !== 1) {
        gaps.push(`${startKind} → ${endKind}: ${start.size} distinct start times and ${end.size} distinct end times`);
        return null;
    }
    const elapsed = [...end][0] - [...start][0];
    if (elapsed < 0) {
        gaps.push(`${startKind} → ${endKind}: end precedes start`);
        return null;
    }
    return elapsed;
}

function recordObservation(target, { kind, at }) {
    if (!target.has(kind)) target.set(kind, new Set());
    target.get(kind).add(timestamp(at));
}

function reviewSubmission(snapshots, gaps) {
    const latest = snapshots.findLast(item => item.phase === 'submission');
    if (!latest) {
        gaps.push('No submission snapshot');
        return { status: 'missing', sha: null };
    }
    const signature = ({ remote, headSha }) =>
        JSON.stringify([remote.status, remote.ref, remote.headSha, remote.submittedSha ?? headSha]);
    const tied = snapshots.filter(item => item.phase === 'submission' &&
        timestamp(item.capturedAt) === timestamp(latest.capturedAt));
    if (tied.some(item => signature(item) !== signature(latest))) {
        gaps.push('Submission snapshots at the same time disagree');
        return { status: 'ambiguous', sha: null };
    }
    const { status, headSha } = latest.remote;
    if (status !== 'match') gaps.push(`Submission remote verification: ${status}`);
    if (status === 'match' && headSha !== latest.headSha) {
        gaps.push('The verified remote SHA differs from the captured checkout HEAD');
    }
    return { status, sha: status === 'match' ? headSha : null };
}

async function main(paths) {
    if (paths.length === 1 && paths[0] === '--help') {
        process.stdout.write('Usage: node tools/assignment-evidence-review.mjs <snapshot-dir>...\n');
        return;
    }
    if (paths.length === 0) throw new Error('Provide at least one snapshot directory. See --help.');
    const directories = new Set();
    for (const path of paths) directories.add(await realpath(path));
    const snapshots = [];
    for (const directory of directories) snapshots.push(await loadSnapshot(directory));
    snapshots.sort((a, b) => timestamp(a.capturedAt) - timestamp(b.capturedAt));
    const { attemptId, assignmentVersion, baseSha } = snapshots[0];
    if (snapshots.some(item => item.attemptId !== attemptId || item.assignmentVersion !== assignmentVersion || item.baseSha !== baseSha)) {
        throw new Error('Snapshots must have the same attempt ID, assignment version, and base SHA');
    }
    const gaps = [];
    const observations = new Map();
    const firstOutput = new Map();
    const sources = new Set();
    for (const snapshot of snapshots) {
        for (const observation of snapshot.observations) recordObservation(observations, observation);
        // Only pair the prompt and output chosen together at one checkpoint.
        if (firstOutputKinds.every(kind => snapshot.observations.some(item => item.kind === kind))) {
            for (const observation of snapshot.observations.filter(item => firstOutputKinds.includes(item.kind))) {
                recordObservation(firstOutput, observation);
            }
        }
        for (const { kind } of snapshot.attachments) sources.add(kind);
    }
    for (const kind of ['chat', 'ai-trace', 'gateway', 'tests']) {
        if (!sources.has(kind)) gaps.push(`No ${kind} attachment`);
    }
    const intervals = {
        assignmentElapsedMs: interval(observations, 'code-ready', 'submitted', gaps),
        firstVisibleOutputMs: interval(firstOutput, ...firstOutputKinds, gaps),
    };
    const submission = reviewSubmission(snapshots, gaps);
    process.stdout.write(`${JSON.stringify({ attemptId, assignmentVersion, baseSha, snapshots, intervals, submission, gaps }, null, 2)}\n`);
}

main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Assignment evidence review: ${error.message}\n`);
    process.exitCode = 1;
});
