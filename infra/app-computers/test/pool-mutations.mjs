/** Offline guard mutation audit. Run with `node test/pool-mutations.mjs`.
 * Mutations are sequential and restored in finally; do not run with other tests. */
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
const cases = [];
function mutation(name, file, from, to, start, end) {
    cases.push({ name, file, change(source) {
        let offset = 0, stop = source.length;
        if (start) { offset = source.indexOf(start); assert.ok(offset >= 0, name + ': start'); }
        if (end) { stop = source.indexOf(end, offset); assert.ok(stop > offset, name + ': end'); }
        const block = source.slice(offset, stop);
        assert.equal(block.split(from).length, 2, name + ': unique mutation');
        return source.slice(0, offset) + block.replace(from, to) + source.slice(stop);
    } });
}
const helper = 'lib/lifecycle/helper.ts', intent = 'lib/lifecycle/intent.ts', iam = 'lib/computer-lifecycle.ts';
const retireStart = "    if(i.operation==='pool-retire'){", retireEnd = "    if(i.operation==='adopt'){";
mutation('pool size bound', 'lib/lifecycle/deployment.ts', "POOL_INSTANCE_TYPES = ['m6i.large', 'm6i.xlarge']", "POOL_INSTANCE_TYPES = ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']");
for (const [name, from] of [
    ['instance required', 'i.providerInstanceId !== null'], ['no data volume', 'i.dataVolumeId === null'],
    ['host identity', 'i.computerId === i.poolHostId'], ['pool generation', 'i.targetGeneration === i.poolGeneration'],
]) mutation('retire schema: ' + name, intent, from, 'true', "    if (i.operation === 'pool-retire')", "    if (i.operation === 'adopt')");
mutation('pool host envelope presence', intent, "['pool-provision', 'pool-retire', 'adopt'].includes(i.operation)", "['pool-provision', 'adopt'].includes(i.operation)");
mutation('pool generation envelope presence', intent, "(['pool-provision', 'pool-retire'].includes(i.operation))", "(i.operation === 'pool-provision')");
mutation('retire receipt state', intent, "['retire', 'release', 'pool-retire']", "['retire', 'release']");
for (const [name, from] of [['volume', 'r.volumeId !== null'], ['host', 'r.poolHostId !== intent.poolHostId'], ['generation', 'r.poolGeneration !== intent.poolGeneration']])
    mutation('pool receipt: ' + name, intent, from, 'false', 'export function validateLifecycleReceipt');
mutation('retire authority identity', 'lib/lifecycle/contract.ts', "['pool-provision','pool-retire'].includes(i.operation)", "i.operation==='pool-provision'");
mutation('retire state machine route', helper, "['pool-provision','pool-retire','adopt','release']", "['pool-provision','adopt','release']");
mutation('retire pool identity tags', helper, '!tagged(host.Tags,poolTagsFor(i))', 'false', retireStart, retireEnd);
mutation('retire computer tag refusal', helper, "host.Tags?.some(t=>['ezil:computer','ezil:computer-id'].includes(t.Key??''))", 'false', retireStart, retireEnd);
mutation('retire legacy computer tag refusal', helper, "['ezil:computer','ezil:computer-id']", "['ezil:computer']", retireStart, retireEnd);
mutation('retire root-only check', helper, 'assertPoolDisks(host,d);', '', retireStart, retireEnd);
mutation('retire state allowlist', helper, "if(!['pending','running','stopping','stopped'].includes(status??''))", 'if(false)', retireStart, retireEnd);
mutation('retire uncertain termination never repeats', helper, "if(phase==='terminated')return wait(phase);", '', retireStart, retireEnd);
mutation('retire waits for terminated', helper, "if(status==='shutting-down')return wait(phase);", '', retireStart, retireEnd);
mutation('terminal networking exception requires termination', helper, "&&['shutting-down','terminated'].includes(host.State?.Name??'')", '');
mutation('terminating instance identity', helper, 'assertIdentity(host,{},i);', '');
mutation('terminating instance type', helper, 'if(host.InstanceType!==i.instanceType)', 'if(false)');
mutation('retired host disk check', helper, "if(!Array.isArray(maps)||maps.length>1||maps.some(m=>m.DeviceName!==d.storage.rootDeviceName))", 'if(false)');
mutation('retired host non-root attachment', helper, 'maps.some(m=>m.DeviceName!==d.storage.rootDeviceName)', 'false', 'function assertRetiredDisks', 'function matchingPresentTags');
mutation('retired host duplicate root', helper, 'maps.length>1', 'false', 'function assertRetiredDisks', 'function matchingPresentTags');
mutation('release host identity', helper, '!tagged(host.Tags,expected)', 'false');
mutation('release host alias agreement', helper, "!matchingPresentTags(host.Tags,{...tagsFor(i),...claim,'ezil:namespace':d.namespace})", 'false');
mutation('release volume fence identity', helper, '!tagged(v.Tags,tagsFor(i))', 'false');
mutation('cold release uses canonical fence after a prior pool epoch', helper, "host?.Tags?.some(t=>t.Key==='ezil:computer')?claim:{'ezil:computer':i.computerId}", 'claim');
mutation('release volume alias agreement', helper, '!matchingPresentTags(v.Tags,releaseVolumeTags)', 'false');
mutation('adopt fresh fence', helper, '(Number(g)<i.targetGeneration&&fence[0].Value===i.fenceToken)', 'false');
mutation('adopt same-generation replay identity', helper, '(Number(g)===i.targetGeneration&&!tagged(v.Tags,{...tagsFor(i),...claim}))', 'false');
mutation('adopt waits for volume retags', helper, "if(phase==='tagged')return wait(phase);", '', "async function observePool");
mutation('release confirms instance-side detach', helper, 'if(host.BlockDeviceMappings?.some(m=>m.DeviceName===DATA_DEVICE))return wait(phase);', '');
mutation('historical recovery rejects retirement', 'lib/lifecycle/recovery-helper.ts', "['pool-provision', 'pool-retire', 'adopt', 'release']", "['pool-provision', 'adopt', 'release']");
const iamRetire = "        // Unclaimed spares", iamRetireEnd = "        // Cold fallback data";
for (const [name, from, to] of [
    ['region', '...region,', ''], ['namespace', '...poolManaged,', '...managed,'],
    ['managed tags', '...poolManaged,', "'aws:ResourceTag/ezil:namespace':d.namespace,"],
    ['pool tag', "'aws:ResourceTag/ezil:pool':'1',", ''],
    ['type allowlist', "'ec2:InstanceType':poolTypes", "'ec2:InstanceType':d.instanceTypes"],
    ['computer tag absence', "'aws:ResourceTag/ezil:computer':'true',", ''],
    ['legacy computer tag absence', ",'aws:ResourceTag/ezil:computer-id':'true'", ''],
    ['instance resource', "resources:[arn('instance')]", "resources:['*']"],
]) mutation('retire IAM: ' + name, iam, from, to, iamRetire, iamRetireEnd);
mutation('legacy IAM cannot bypass pool limits', iam, ",'aws:ResourceTag/ezil:computer':'true'", '', '// anything but userData', '// AttachVolume authorizes');
mutation('release IAM excludes pooled hosts', iam, ",'aws:ResourceTag/ezil:pool':'true'", '', "...pool(new iam.PolicyStatement({actions:['ec2:StopInstances'", iamRetire);
mutation('pool IAM namespace scope', iam, ",'aws:ResourceTag/ezil:namespace':d.namespace", '', 'const poolManaged=', 'const requestTags=');
mutation('pool launch type denial', iam, 'effect:iam.Effect.DENY', 'effect:iam.Effect.ALLOW', '// The shared cold launch grant', '// The disposable root disk');
mutation('pool launch deny does not affect cold launches', iam, "Null:{'aws:RequestTag/ezil:pool':'false'},", '', '// The shared cold launch grant', '// The disposable root disk');
for (const [name, from] of [['owner', "'aws:ResourceTag/ezil:computer-id':'false',"], ['zone', ",'ec2:AvailabilityZoneId':d.zoneId"], ['region', '...region,'], ['managed tags', '...managed,']])
    mutation('cold detach IAM: ' + name, iam, from, '', '// Cold fallback data', "StringEquals:{...region,...managed,'ec2:AvailabilityZoneId':d.zoneId},Null:");
mutation('ops kill-switch blocks pool launch', 'lib/ops.ts', "'ec2:RunInstances', ", '', 'export function killSwitchStatements', 'export class OpsStack');
mutation('boundary and identity kill-switch block pool launch', 'lib/identity.ts', "'ec2:RunInstances', ", '', 'export const KILL_SWITCH_ACTIONS', 'const allow =');
const files = ['test/lifecycle-pool.test.ts', 'test/pool-iam.test.ts', 'test/lifecycle-recovery.test.ts'];
const args = ['--import', 'tsx', '--test', '--test-isolation=none', '--test-reporter=tap', ...files];
const log = join(mkdtempSync(join(tmpdir(), 'pool-mutations-')), 'test.log');
const run = () => {
    // File stdio also works in sandboxes that prohibit Node's synchronous pipes.
    const fd = openSync(log, 'w');
    try {
        const result = spawnSync(process.execPath, args, { timeout: 30000, stdio: ['ignore', fd, fd],
            env: { ...process.env, npm_config_offline: 'true', TSX_DISABLE_CACHE: '1' } });
        return { ...result, stdout: readFileSync(log, 'utf8'), stderr: '' };
    } finally { closeSync(fd); }
};
const baseline = run();
assert.equal(baseline.error, undefined);
assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
assert.match(baseline.stdout, /# tests [1-9][0-9]+/);
console.log(baseline.stdout.match(/# tests \d+/)[0] + ' baseline');
const filters = process.argv.slice(2);
const selected = filters.length ? cases.filter(c => filters.some(filter => c.name.includes(filter))) : cases;
assert.ok(selected.length > 0);
let killed = 0;
for (const c of selected) {
    const original = readFileSync(c.file, 'utf8');
    try {
        writeFileSync(c.file, c.change(original));
        const result = run();
        assert.ok(result.status !== null && !result.error, c.name + ': runner failed');
        const caught = result.status !== 0 && /ERR_ASSERTION/.test(result.stdout);
        if (caught) { killed++; console.log('KILLED ' + c.name); }
        else { console.log('SURVIVED ' + c.name); writeFileSync('/tmp/pool-mutant-last.log', result.stdout + result.stderr); }
    } finally { writeFileSync(c.file, original); }
}
console.log(`${killed}/${selected.length} mutations killed`);
if (killed !== selected.length) process.exitCode = 1;
