// Offline guard mutations. Run alone from infra/app-computers; sources restored.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, openSync, closeSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
const paths = { helper: 'lib/lifecycle/helper.ts', intent: 'lib/lifecycle/intent.ts' };
const original = Object.fromEntries(Object.entries(paths).map(([k, p]) => [k, readFileSync(p, 'utf8')]));
const mutants = [];
const add = (key, name, before, after = 'false') => {
    const start = key === 'helper' ? original[key].indexOf('async function observeAdoptRecovery') : original[key].indexOf('export function validateAdoptRecovery');
    const end = key === 'helper' ? original[key].indexOf('/** Pool steps share', start) : original[key].length;
    const part = original[key].slice(start, end);
    assert.equal(part.split(before).length, 2, name);
    let changed = part.replace(before, after);
    // Claim agreement is also enforced by the complete-or-absent check. Mutate
    // both redundant predicates to test that foreign claims cannot be overwritten.
    if (name === 'claim aliases agree') changed = changed.replace("(!claimed&&host.Tags?.some(t=>Object.keys(claim).includes(t.Key??'')))", 'false');
    mutants.push({ key, name, text: original[key].slice(0, start) + changed + original[key].slice(end) });
};
for (const [name, target] of [
    ['pinned original AMI', 'host.ImageId!==d.amiId'], ['pool host binding', "'ezil:pool-host':source.poolHostId!,"],
    ['canonical aliases absent', "host.Tags?.some(t=>['ezil:computer-id','ezil:fence-token'].includes(t.Key??''))"],
    ['claim aliases agree', '!matchingPresentTags(host.Tags,claim)'],
    ['partial claim absent', "(!claimed&&host.Tags?.some(t=>Object.keys(claim).includes(t.Key??'')))"],
    ['pool tag required', "(!claimed&&!tagged(host.Tags,{'ezil:pool':'1'}))"],
    ['owned volume tags', '!tagged(v.Tags,tagsFor(i))'], ['data key', 'v.KmsKeyId!==d.dataKeyArn'],
    ['multiattach forbidden', 'v.MultiAttachEnabled!==false'],
    ['attachment wait', 'if(v.Attachments.length===0)return wait(phase);'],
    ['preserve claimed phase', "if(phase!=='attached')return wait(phase);"],
    ['preexisting claim forbidden', "if(phase==='attached')return fail('lifecycle_instance_invalid');"],
    ['preserve unpooled phase', "if(phase==='unpooled')return wait(phase);"],
]) add('helper', name, target, target.endsWith(';') || target.endsWith(',') ? '' : 'false');
add('helper', 'attachment validation', 'assertAttached(host,v,host.InstanceId!);', '');
add('helper', 'extra disks refused', 'assertPoolDisks(host,d,v.VolumeId);', '');
for (const [name, target] of [
    ['digest', "createHash('sha256').update(c.sourceDocument).digest('hex') !== c.sourceDigest"],
    ['version', 'c.sourceVersion !== source.deployment.stateMachineVersionArn'],
    ['execution', "c.executionArn !== c.sourceVersion.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:computer-${source.jobId}`)"],
    ['ACK after enter', 'c.proof.attachEntered >= c.proof.attachAcknowledged'],
    ['ACK before terminal', 'c.proof.attachAcknowledged >= c.proof.terminal'],
]) add('intent', name, target);
function run() {
    return new Promise((resolve, reject) => {
        const dir = mkdtempSync('/tmp/recadopt-mut-'), log = dir + '/test.log', fd = openSync(log, 'w');
        const child = spawn(process.execPath, ['--import', 'tsx', '--test-reporter=tap', '-e', "require('./test/lifecycle-pool.test.ts')"],
            { stdio: ['ignore', fd, fd], timeout: 60000, env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
        closeSync(fd); child.on('error', reject); child.on('close', status => {
            const output = readFileSync(log, 'utf8'); rmSync(dir, { recursive: true });
            resolve({ status, count: Number(output.match(/^# tests (\d+)$/m)?.[1]), output });
        });
    });
}
const baseline = await run(); assert.equal(baseline.status, 0, baseline.output); assert.ok(baseline.count >= 300, baseline.output);
const survived = [];
try {
    for (const m of mutants) {
        writeFileSync(paths[m.key], m.text); let r;
        try { r = await run(); } finally { writeFileSync(paths[m.key], original[m.key]); }
        assert.equal(r.count, baseline.count, `invalid mutant ${m.name}\n${r.output}`);
        if (!r.status) survived.push(m.name);
        console.log(`${r.status ? 'KILLED' : 'SURVIVED'}: ${m.name}`);
    }
} finally { for (const [k, p] of Object.entries(paths)) writeFileSync(p, original[k]); }
assert.deepEqual(survived, [], 'surviving guards'); console.log(`${mutants.length}/${mutants.length} mutants killed`);
