// Run from infra/app-computers: node test/mutation-warm-open.mjs
// Offline, sequential mutations. Do not edit these files or run other tests concurrently.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mutants = [
    { name: 'Q5 revert attach poll to two seconds', file: 'lib/lifecycle/helper.ts',
        before: "delaySeconds:phase==='attached'?1:2", after: "delaySeconds:phase==='attached'?2:2",
        suite: 'test/lifecycle-fast.test.ts', pattern: 'first adopt attach observation' },
    { name: 'Q6 disable secret TTL expiry', file: 'lib/lifecycle/aws.ts',
        before: 'expiresAt:now+60000', after: 'expiresAt:Infinity',
        suite: 'test/lifecycle-aws.test.ts', pattern: 'authority secret cache expires at 60 seconds' },
];
const out = mkdtempSync(join(tmpdir(), 'ezil-warm-open-mutants-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_')));
Object.assign(env, { AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true' });
try {
    for (const [index, mutant] of mutants.entries()) {
        const original = readFileSync(mutant.file, 'utf8'), logPath = join(out, `${index}.log`);
        assert.equal(original.split(mutant.before).length, 2, `expected one target: ${mutant.name}`);
        try {
            writeFileSync(mutant.file, original.replace(mutant.before, mutant.after));
            const log = openSync(logPath, 'w'); let result;
            try {
                result = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-isolation=none',
                    `--test-name-pattern=${mutant.pattern}`, mutant.suite], { env, stdio: ['ignore', log, log] });
            } finally { closeSync(log); }
            const output = readFileSync(logPath, 'utf8');
            assert.equal(result.error, undefined);
            assert.equal(result.signal, null);
            assert.equal(result.status, 1, `mutant survived: ${mutant.name}\n${output}`);
            assert.match(output, /ERR_ASSERTION/, `expected an assertion failure: ${mutant.name}\n${output}`);
            console.log(`KILLED: ${mutant.name}`);
        } finally { writeFileSync(mutant.file, original); }
    }
    console.log(`${mutants.length}/${mutants.length} warm-open mutants killed; sources restored.`);
} finally { rmSync(out, { recursive: true, force: true }); }
