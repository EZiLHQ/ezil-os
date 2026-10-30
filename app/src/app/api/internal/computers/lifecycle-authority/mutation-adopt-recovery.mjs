// Run the complete recovery acceptance and regression suites, including no-usage completion.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import ts from 'typescript';
const file = 'src/server/lib/compute/aws-pool-recovery.ts', original = readFileSync(file, 'utf8');
const source = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
const mutations = [];
const wanted = ['i.operation ===', 'r.id ===', 'e.status ===', 'event.id ===', 'enters.length ===',
    'details?.resource ===', 'parameters.InstanceId ===', 'started && ack', 'v && v.volumeId', "v!.state === 'in-use'",
    'h && h.instanceId', 'releasedHost &&', "v!.state === 'available'", 'current && current.state', 'e.input === saved.input', 'r.jobId === p.lifecycleJobId',
    "p.state === 'UNCONFIRMED' && matchesAdoptRecovery"];
function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 'guardRecovery') {
        const arg = node.arguments[0], text = arg.getText(source);
        const name = wanted.find(prefix => text.startsWith(prefix));
        if (name) mutations.push({ name, text: original.slice(0, arg.getStart(source)) + 'true' + original.slice(arg.end) });
    }
    ts.forEachChild(node, visit);
}
visit(source); assert.equal(mutations.length, wanted.length);
mutations.push({ name: 'no enrollment issued/consumed', text: original.replace('return p.enrollNonceHash === null && p.enrollConsumedHash === null && p.enrollExpiresAt === null;', 'return true;') });
const placementFile = 'src/server/lib/compute/placement.ts', clientFile = 'src/server/lib/compute/aws-clients.ts';
const originals = new Map([file, placementFile, clientFile].map(f => [f, readFileSync(f, 'utf8')]));
function change(name, target, before, after) {
    const source = originals.get(target);
    assert.equal(source.split(before).length, 2, `one mutation target: ${name}`);
    mutations.push({ name, file: target, text: source.replace(before, after) });
}
change('no-usage completion actually bypasses terminal usage SQL', placementFile,
    'if (!unopenedAdopt) await applyTransitionUsageInTx(tx, placement, usage);', 'await applyTransitionUsageInTx(tx, placement, usage);');
change('ordinary terminal usage still closes', placementFile,
    'if (!unopenedAdopt) await applyTransitionUsageInTx(tx, placement, usage);', 'if (false) await applyTransitionUsageInTx(tx, placement, usage);');
change('ledger disqualifies at initiation and completion', placementFile,
    "if (rows.length !== 0) throw new Error('adopt_recovery_usage');", "if (false) throw new Error('adopt_recovery_usage');");
change('dedicated completion requires exact recovery and fixed fields', placementFile,
    "if (completion === 'unopened-adopt') {", 'if (false) {');
change('saved version cannot initiate another attempt', file,
    "if (saved && p.state === 'UNCONFIRMED') return true;",
    "if (saved && p.state === 'UNCONFIRMED') { await startLifecycleJob(deps.starter!, p.region!, saved, deps.sleep); return true; }");
change('atomic placement lock before admission', file,
    'const current = await lockPoolClaimPlacement(tx, p.computerId);', 'const current = p;');
change('pool lock before eligibility', file,
    '${lock ? sql`FOR UPDATE` : sql``}', '${sql``}');
change('history follows all pages', clientFile, 'if (out.nextToken === undefined) return events;', 'return events;');
change('history page bound', clientFile, 'page < 100', 'page < 101');
change('history event bound', clientFile, 'events.length + out.events.length > 10000', 'false');
change('history byte bound', clientFile, 'bytes > 8 * 1024 * 1024', 'false');
function run() {
    return new Promise((resolve, reject) => {
        const dir = mkdtempSync('/tmp/recadopt-app-mut-'), log = dir + '/test.json', err = dir + '/error.log';
        const fd = openSync(log, 'w'), ef = openSync(err, 'w');
        const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'src/server/lib/compute/aws-pool-adopt-recovery.test.ts',
            'src/app/api/internal/computers/lifecycle-authority/adopt-recovery.test.ts',
            'src/server/lib/compute/placement-adopt-completion.test.ts', 'src/server/lib/compute/aws-clients.test.ts', '--maxWorkers=1', '--reporter=json'],
            { stdio: ['ignore', fd, ef], timeout: 60000 });
        closeSync(fd); closeSync(ef); child.on('error', reject); child.on('close', status => {
            try { const r = JSON.parse(readFileSync(log, 'utf8')); resolve({ status, count: r.numTotalTests, failed: r.numFailedTests }); }
            catch (e) { reject(new Error(String(e) + readFileSync(err, 'utf8'))); }
            finally { rmSync(dir, { recursive: true }); }
        });
    });
}
const baseline = await run(); assert.equal(baseline.status, 0); assert.ok(baseline.count >= 217);
console.log(`Baseline: ${baseline.count} tests including the STOPPED/no-usage acceptance test`);
const survived = [];
try {
    for (const m of mutations) {
        const target = m.file ?? file;
        writeFileSync(target, m.text); let r; try { r = await run(); } finally { writeFileSync(target, originals.get(target)); }
        assert.equal(r.count, baseline.count, `invalid mutant ${m.name}`);
        if (!r.failed || !r.status) survived.push(m.name);
        console.log(`${r.failed && r.status ? 'KILLED' : 'SURVIVED'}: ${m.name}`);
    }
} finally { for (const [target, content] of originals) writeFileSync(target, content); }
assert.deepEqual(survived, []); console.log(`${mutations.length}/${mutations.length} guard groups killed; sources restored`);
