// Run from app: node src/app/api/internal/computers/lifecycle-authority/mutation-recovery.mjs
// Offline and sequential. Do not edit/run route tests concurrently; source is restored in finally.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const route = new URL('./route.ts', import.meta.url), original = readFileSync(route, 'utf8');
const suite = 'src/app/api/internal/computers/lifecycle-authority/recovery.test.ts';
const mutants = [
    ['deny all recovery', '!isPoolReleaseRecovering(record)', 'true'],
    ['allow every RECOVERING row', "'DRAINING', 'STOPPING', 'RETIRING',", "'DRAINING', 'STOPPING', 'RETIRING', 'RECOVERING',"],
    ['replay must still be RECOVERING', '!isPoolReleaseRecovering(record)', 'false'],
    ['release operation', "work.intent.operation !== 'release'", 'false'],
    ['pool deployment', '!isPoolMode(work.intent.deployment)', 'false'],
    ['replay identity', '!matchesPoolReleaseRecovery(record, work)', 'false'],
    ['job identity', 'record.lifecycleJobId !== authority.jobId', 'false'],
    ['digest identity', 'record.lifecycleDigest !== authority.digest', 'false'],
    ['lease identity', 'record.leaseEpoch !== authority.leaseEpoch', 'false'],
    ['live computer', 'computer.deleted', 'false'],
    ['computer owner', 'computer.userId !== record.ownerUserId', 'false'],
    ['computer must exist', '!computer || computer.deleted || computer.userId !== record.ownerUserId', 'computer && (computer.deleted || computer.userId !== record.ownerUserId)'],
];
function run() {
    const dir = mkdtempSync(join(tmpdir(), 'r111fix-authority-')), report = join(dir, 'results.json');
    const log = openSync(join(dir, 'test.log'), 'w');
    try {
        const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', suite,
            '--reporter=json', '--outputFile', report], { stdio: ['ignore', log, log], timeout: 60000,
            env: { ...process.env, npm_config_offline: 'true' } });
        assert.ifError(result.error);
        const tests = JSON.parse(readFileSync(report, 'utf8'));
        return { status: result.status, tests };
    } finally { closeSync(log); rmSync(dir, { recursive: true, force: true }); }
}
const baseline = run();
assert.equal(baseline.status, 0); assert.ok(baseline.tests.numPassedTests > 20);
console.log(`baseline: ${baseline.tests.numPassedTests} passed`);
let killed = 0;
try {
    for (const [name, before, after] of mutants) {
        assert.equal(original.split(before).length, 2, `unique target: ${name}`);
        writeFileSync(route, original.replace(before, after));
        let result;
        try { result = run(); } finally { writeFileSync(route, original); }
        assert.equal(result.tests.numTotalTests, baseline.tests.numTotalTests, `invalid mutant: ${name}`);
        assert.notEqual(result.status, 0, `SURVIVED: ${name}`);
        assert.ok(result.tests.numFailedTests > 0, `assertion failure required: ${name}`);
        console.log(`KILLED ${++killed}/${mutants.length}: ${name}`);
    }
} finally { writeFileSync(route, original); }
console.log(`${killed}/${mutants.length} mutants killed; source restored`);
