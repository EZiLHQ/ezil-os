// Run from infra/app-computers: node test/mutation-release.mjs
// Offline, sequential source mutations; every file is restored in finally.
// Do not run other tests or edit these files while this check is running.
import assert from 'node:assert/strict';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const helper = 'lib/lifecycle/helper.ts', iam = 'lib/computer-lifecycle.ts', definition = 'lib/lifecycle/definition.ts';
const originals = new Map([helper, iam, definition].map(file => [file, readFileSync(file, 'utf8')]));
const suites = { helper: 'test/lifecycle-pool.test.ts', iam: 'test/pool-iam.test.ts', fast: 'test/lifecycle-fast.test.ts' };
const mutants = [];
function replace(source, before, after) {
    assert.equal(source.split(before).length, 2, `mutation must have one target: ${before}`);
    return source.replace(before, after);
}
function add(name, file, transform, suite = file === helper ? 'helper' : 'iam') {
    mutants.push({ name, file, source: transform(originals.get(file)), suite });
}
function change(name, before, after) { add(name, helper, source => replace(source, before, after)); }

change('launch-template provenance', "&&!tagged(host.Tags,{'aws:ec2launchtemplate:id':d.launchTemplateId})", '&&false');
const drain = "const draining=i.operation==='release'||i.operation==='pool-retire';";
for (const operation of ['release', 'pool-retire'])
    change(`${operation} permits legacy AMI`, drain, `const draining=i.operation==='${operation === 'release' ? 'pool-retire' : 'release'}';`);
for (const operation of ['start', 'adopt', 'provision', 'replace', 'pool-provision'])
    change(`${operation} retains strict AMI`, drain, `${drain.slice(0, -1)}||i.operation==='${operation}';`);

for (const [name, guard] of Object.entries({
    subnet: '||v.SubnetId!==d.subnetId',
    'exact instance type': '||v.InstanceType!==i.instanceType',
    'root device': '||v.RootDeviceName!==d.storage.rootDeviceName',
    'single security group': '||v.SecurityGroups?.length!==1',
    'security group identity': '||v.SecurityGroups[0]?.GroupId!==d.securityGroupId',
    IMDSv2: "||v.MetadataOptions?.HttpTokens!=='required'",
    'metadata hop limit': '||v.MetadataOptions.HttpPutResponseHopLimit!==1',
    'metadata tags disabled': "||v.MetadataOptions.InstanceMetadataTags!=='disabled'",
})) change(name, guard, '');

for (const key of ['ezil:computer-id', 'ezil:generation', 'ezil:fence-token', 'ezil:computer', 'ezil:fence']) {
    const omit = expression => `Object.fromEntries(Object.entries(${expression}).filter(([key])=>key!=='${key}'))`;
    add(`release ownership ${key}`, helper, source => replace(replace(source,
        'tagged(host.Tags,expected)', `tagged(host.Tags,${omit('expected')})`),
        "matchingPresentTags(host.Tags,{...tagsFor(i),...claim,'ezil:namespace':d.namespace})",
        `matchingPresentTags(host.Tags,${omit("{...tagsFor(i),...claim,'ezil:namespace':d.namespace}")})`));
}
change('pool-host ownership', "if(!host||!tagged(host.Tags,poolTagsFor(i))", "if(!host||!tagged(host.Tags,Object.fromEntries(Object.entries(poolTagsFor(i)).filter(([key])=>key!=='ezil:pool-host')))" );
change('non-force detach', "VolumeId:v.VolumeId,Force:false});", "VolumeId:v.VolumeId,Force:true});");

// R111FIX: classify disk snapshots before waiting, preserving strict guards.
change('release transient observations wait', '!releaseDisksReady(host,d,v.VolumeId)', 'false');
change('release stopping permits transient observations', "(status==='stopping'||status==='stopped')", "status==='stopped'");
change('release stopped permits transient observations', "(status==='stopping'||status==='stopped')", "status==='stopping'");
change('empty stopping snapshot waits', "if(maps.length===0&&host.State?.Name==='stopping')return false;", '');
change('empty stopped snapshot fails', "maps.length===0&&host.State?.Name==='stopping'", 'maps.length===0');
change('missing volume identity waits', 'if(maps.some(m=>!m.Ebs?.VolumeId))return false;', '');
change('unknown device fails before transient wait', 'm.DeviceName!==DATA_DEVICE||(!!m.Ebs?.VolumeId&&m.Ebs.VolumeId!==dataVolumeId)', 'false');
change('foreign data fails before transient wait', '(!!m.Ebs?.VolumeId&&m.Ebs.VolumeId!==dataVolumeId)', 'false');
add('duplicate root fails before transient wait', helper, source => replace(replace(source,
    '||root!.length>1', ''), 'if(root!.length!==1)', 'if(root!.length<1)'));
change('root attachment must settle', "return root![0]?.Ebs?.Status==='attached'", 'return true');
change('data attaching must settle', "m.Ebs?.Status==='attaching'||m.Ebs?.Status==='detaching'", "m.Ebs?.Status==='detaching'");
change('data detaching must settle', "m.Ebs?.Status==='attaching'||m.Ebs?.Status==='detaching'", "m.Ebs?.Status==='attaching'");
change('data cannot be used as root', '||root![0]?.Ebs?.VolumeId===dataVolumeId', '');
change('Lambda keeps sanitized disk evidence', "if(error instanceof UnexpectedDisksError)failure.message+=' '+JSON.stringify({disks:error.disks});", '');
change('disk diagnostics contain root identity', 'matchesRoot:!!m.Ebs?.VolumeId&&m.Ebs.VolumeId===rootId', 'matchesRoot:false');
change('disk diagnostics contain data identity', 'matchesData:!!dataVolumeId&&m.Ebs?.VolumeId===dataVolumeId', 'matchesData:false');

function fast(name, before, after, file = helper) {
    add(name, file, source => replace(source, before, after), 'fast');
}
fast('fast observation poll', "Wait:{Type:'Wait',Seconds:2,Next:'Resume'}", "Wait:{Type:'Wait',Seconds:5,Next:'Resume'}", definition);
fast('caught actions retain one-second wait', "States[next]={Type:'Wait',Seconds:1", "States[next]={Type:'Wait',Seconds:5", definition);
const immediateSuccess = "ResultSelector:NO_ERROR,ResultPath:'$.ctl.lastError',Next:'Observe-'+afterAction[name as Action]";
for (const action of ['createVolume', 'runInstances', 'runBurstableInstances', 'attachVolume', 'detachVolume',
    'createTags', 'claimInstance', 'deleteTags', 'modifyInstanceAttribute', 'startInstances', 'stopInstances', 'terminateInstances'])
    fast(`${action} success skips the unconditional wait`, immediateSuccess,
        `ResultSelector:NO_ERROR,ResultPath:'$.ctl.lastError',Next:name==='${action}'?next:'Observe-'+afterAction[name as Action]`, definition);
fast('immediate success records the attempted phase', immediateSuccess,
    "ResultSelector:NO_ERROR,ResultPath:'$.ctl.lastError',Next:'Observe-initial'", definition);
fast('immediate success clears the previous error', immediateSuccess,
    "ResultSelector:NO_ERROR,ResultPath:null,Next:'Observe-'+afterAction[name as Action]", definition);
fast('caught errors keep the After path', "Catch:[{ErrorEquals:['States.ALL'],ResultPath:'$.ctl.lastError',Next:next}]",
    "Catch:[{ErrorEquals:['States.ALL'],ResultPath:'$.ctl.lastError',Next:'Observe-'+afterAction[name as Action]}]", definition);
fast('caught errors cannot introduce a zero-wait retry loop', "States[next]={Type:'Wait',Seconds:1", "States[next]={Type:'Wait',Seconds:0", definition);
fast('lagging observations cannot introduce a zero-wait retry loop', "Wait:{Type:'Wait',Seconds:2,Next:'Resume'}",
    "Wait:{Type:'Wait',Seconds:0,Next:'Resume'}", definition);
const allocations = ['createVolume', 'runInstances', 'runBurstableInstances'];
const allocationList = "['createVolume','runInstances','runBurstableInstances']";
for (const action of allocations)
    fast(`confirmed ${action} waits for visibility`, allocationList, JSON.stringify(allocations.filter(a => a !== action)));
fast('lost allocations retain tokenized retry', "&&classifyProviderError(event.lastError).kind==='none'", '');
fast('throttle re-arm preserves prior progress', 'phase:beforeRejectedAction(i,event.phase)', "phase:'initial'");
for (const phase of ['instance', 'tagged', 'attached', 'claimed', 'unpooled', 'terminated', 'detached', 'started']) {
    const line = originals.get(helper).split('\n').find(line => line.includes(`case '${phase}':return`));
    assert.ok(line);
    fast(`throttle ${phase} preserves prior progress`, line, `        case '${phase}':return 'initial';`);
}
fast('invisible launch cannot rewind later phases', "&&['tagged','attached'].includes(event.phase)", '&&false');
fast('cold retags cannot rewind attached phase', "['tagged','attached'].includes(phase)", "phase==='tagged'");
for (const [name, phases] of [
    ['adopt retags', ['tagged', 'attached', 'claimed', 'unpooled']],
    ['adopt attach', ['attached', 'claimed', 'unpooled']],
    ['adopt claim', ['claimed', 'unpooled']],
]) {
    for (const phase of phases) {
        const list = '[' + phases.map(p => `'${p}'`).join(',') + ']';
        fast(`${name} retains ${phase} phase`, `${list}.includes(phase)`, `${JSON.stringify(phases.filter(p => p !== phase))}.includes(phase)`);
    }
}

const policy = originals.get(iam);
// ATTACHWAIT: distinguish missing attachment evidence from positive mismatch.
const emptyCold = "if(v.Attachments.length===0&&phase==='attached')return wait(phase);";
const emptyAdopt = "if(v.Attachments.length===0&&['attached','claimed','unpooled'].includes(phase))return wait(phase);";
const emptyStart = "if(v.Attachments.length===0&&['userdata','started'].includes(phase))return wait(phase);";
const emptyRelease = 'if(v.Attachments.length===0&&!free)return wait(phase);';
for (const [name, guard] of [['cold', emptyCold], ['adopt', emptyAdopt], ['start', emptyStart], ['release', emptyRelease]]) {
    fast(`ATTACHWAIT ${name} empty observations wait`, guard, '');
    fast(`ATTACHWAIT ${name} cannot rewind progress`, guard, guard.replace('wait(phase)', "wait('initial')"));
    fast(`ATTACHWAIT ${name} foreign attachments cannot wait`, guard, guard.replace('v.Attachments.length===0', 'true'));
}
fast('ATTACHWAIT adopt cannot require available state', emptyAdopt, emptyAdopt.replace('v.Attachments.length===0', "v.State==='available'&&v.Attachments.length===0"));
fast('ATTACHWAIT release must observe availability before terminating', emptyRelease, emptyRelease.replace('return wait(phase)', "v.State='available'"));

const coldStart = policy.indexOf("        new iam.PolicyStatement({actions:['ec2:StartInstances'");
const cold = policy.slice(coldStart, policy.indexOf("        new iam.PolicyStatement({actions:['ec2:AttachVolume'", coldStart));
const claimedStart = policy.indexOf("        ...pool(new iam.PolicyStatement({actions:['ec2:StopInstances'");
const claimed = policy.slice(claimedStart, policy.indexOf('        // Unclaimed spares', claimedStart));
const omitSpread = (spread, key) => `...Object.fromEntries(Object.entries(${spread}).filter(([key])=>key!=='${key}')),`;
for (const [variant, block, spread] of [['cold', cold, 'managed'], ['adopted', claimed, 'poolManaged']]) {
    const conditions = [
        ...(variant === 'cold' ? [
            ['region', 'aws:RequestedRegion'], ['managed-by', 'ec2:ResourceTag/ezil:managed-by'], ['stage', 'ec2:ResourceTag/ezil:stage'],
        ].map(([name, key]) => [name, '...existing,', `StringEquals:Object.fromEntries(Object.entries(existing.StringEquals).filter(([key])=>key!=='${key}')),`]) : [
            ['region', '...region,', ''],
            ['managed-by', `...${spread},`, omitSpread(spread, 'ec2:ResourceTag/ezil:managed-by')],
            ['stage', `...${spread},`, omitSpread(spread, 'ec2:ResourceTag/ezil:stage')],
        ]),
        ['unpooled host', ",'aws:ResourceTag/ezil:pool':'true'", ''],
        ...(variant === 'cold' ? [
            ['computer-id presence', "'aws:ResourceTag/ezil:computer-id':'false',", ''],
            ['claim alias absent', "'aws:ResourceTag/ezil:computer':'true',", ''],
        ] : [
            ['namespace', '...poolManaged,', omitSpread('poolManaged', 'aws:ResourceTag/ezil:namespace')],
            ['type allowlist', ",'ec2:InstanceType':poolTypes", ''],
            ['claim presence', "'aws:ResourceTag/ezil:computer':'false',", ''],
        ]),
    ];
    for (const [name, before, after] of conditions)
        add(`${variant} detach ${name}`, iam, source => replace(source, block, replace(block, before, after)));
}

function run(suite) {
    return new Promise((resolve, reject) => {
        const directory = mkdtempSync(join(tmpdir(), 'infrarel-mutation-'));
        const log = join(directory, 'test.log'), outputFd = openSync(log, 'w');
        // Require the suite synchronously: this also exercises freshly changed
        // sources on Node 24 where the tsx ESM test entry can exit without cases.
        const child = spawn(process.execPath, ['--import', 'tsx', '--test-reporter=tap', '-e', `require(${JSON.stringify('./' + suites[suite])})`], {
            stdio: ['ignore', outputFd, outputFd], timeout: 60000,
            env: { ...process.env, npm_config_offline: 'true', TSX_DISABLE_CACHE: '1' },
        });
        closeSync(outputFd);
        child.on('error', reject);
        child.on('close', status => {
            const output = readFileSync(log, 'utf8'); rmSync(directory, { recursive: true });
            resolve({ status, output, count: Number(output.match(/^# tests (\d+)$/m)?.[1]) });
        });
    });
}
const counts = {};
for (const suite of Object.keys(suites)) {
    const result = await run(suite);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.count > 10, `must execute individual cases\n${result.output}`);
    counts[suite] = result.count;
    console.log(`baseline ${suite}: ${result.count} passed`);
}
let killed = 0;
try {
    for (const mutant of mutants) {
        writeFileSync(mutant.file, mutant.source);
        let result;
        try { result = await run(mutant.suite); } finally { writeFileSync(mutant.file, originals.get(mutant.file)); }
        assert.equal(result.count, counts[mutant.suite], `invalid mutant ${mutant.name}\n${result.output}`);
        assert.notEqual(result.status, 0, `SURVIVED: ${mutant.name}`);
        assert.match(result.output, /^not ok /m, `must fail an assertion: ${mutant.name}`);
        killed++;
        console.log(`KILLED ${killed}/${mutants.length}: ${mutant.name}`);
    }
} finally {
    for (const [file, original] of originals) writeFileSync(file, original);
}
console.log(`${killed}/${mutants.length} mutants killed; sources restored`);
