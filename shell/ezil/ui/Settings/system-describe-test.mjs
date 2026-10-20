// system-describe-test.mjs — EZiL-authored. Pure wording tests for Settings → System.
// Run: node shell/ezil/ui/Settings/system-describe-test.mjs   (exit 0 pass, 1 fail)
import { describeImage, describeMachine, describeProvider, describeScreenError, describeTransport, describeUsage, VITALS_STALE_MS } from './tabs/system-describe.js';

const results = [];
const push = (name, ok, detail) => results.push({ name, ok: !! ok, detail });

const aws = { provider: 'aws-ec2', providerSource: 'placement', machine: { vcpu: 2, memoryMiB: 4096, instanceType: 't3a.medium', region: 'us-east-1', source: 'configured' }, lifecycleState: 'RUNNING', usage: null };
const cf = { provider: 'cloudflare', providerSource: 'placement', machine: { vcpu: 2, memoryMiB: 6144, instanceType: null, region: null, source: 'configured' }, lifecycleState: null, usage: null };
const unassigned = { provider: 'unassigned', providerSource: 'no_placement', machine: { vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' }, lifecycleState: null, usage: null };

// Provider
push('AWS placement names AWS and its region', describeProvider(aws).value === 'AWS EC2 (us-east-1)', describeProvider(aws));
push('Cloudflare placement names Cloudflare Containers', describeProvider(cf).value === 'Cloudflare Containers');
push('🔴 no placement is "Not assigned yet", never Cloudflare', describeProvider(unassigned).value === 'Not assigned yet');
push('🔴 unreadable info is Unknown, never Cloudflare', describeProvider(null, 'UPSTREAM').value === 'Unknown');
push('missing endpoint says the deployment cannot report it', /cannot report/.test(describeProvider(null, 'UNSUPPORTED').hint));
push('unknown provider value is Unknown', describeProvider({ provider: 'unknown' }).value === 'Unknown');
const readsOff = { provider: 'unknown', providerSource: 'reads_off', configuredRouting: 'cloudflare', machine: { vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' }, lifecycleState: null, usage: null };
push('🔴 reads off: provider is Unknown, not Cloudflare', describeProvider(readsOff).value === 'Unknown', describeProvider(readsOff));
push('🔴 reads off: the hint separates configured routing from verification',
    /configured to start computers on Cloudflare/.test(describeProvider(readsOff).hint) && /not verified/.test(describeProvider(readsOff).hint)
    && ! /Every computer/.test(describeProvider(readsOff).hint));
push('🔴 reads off: no Cloudflare size is presented', describeMachine(readsOff).value === '—', describeMachine(readsOff));

// Image
const imageId = 'EZiL_os-2026.10:abcdef0123456789';
const runningImage = describeImage({ ...cf, image: { id: imageId, source: 'running' } });
push('Image row shows the first 12 characters of the running image', runningImage.value === imageId.slice(0, 12), runningImage);
push('Image row preserves the full image ID for its title', runningImage.title === imageId, runningImage);
push('short image IDs are shown in full', describeImage({ image: { id: 'abc123', source: 'running' } }).value === 'abc123');
for ( const info of [null, cf, aws, unassigned, readsOff, { image: { id: null, source: 'unknown' } }, { image: { id: imageId, source: 'unknown' } }, { image: { id: '', source: 'running' } }] ) {
    const image = describeImage(info);
    push('unknown Image row explicitly says Not reported yet, with no guessed title', image.value === 'Not reported yet' && image.title === '', image);
}

// Machine
push('AWS size from the recorded instance type', describeMachine(aws).value === '2 vCPU · 4 GiB RAM (t3a.medium)', describeMachine(aws).value);
push('Cloudflare size is the configured container class', describeMachine(cf).value === '2 vCPU · 6 GiB RAM' && /Configured/.test(describeMachine(cf).hint));
push('🔴 sizes are labelled configured, not live', /not a live measurement/.test(describeMachine(aws).hint));
push('unassigned machine is unknown (em dash)', describeMachine(unassigned).value === '—');
push('unlisted instance type shows its name, size unknown',
    describeMachine({ machine: { vcpu: null, memoryMiB: null, instanceType: 'x9.huge', source: 'unknown' } }).value === 'x9.huge');
push('no info → em dash', describeMachine(null).value === '—');

// Usage
push('🔴 usage says Not measured (no invented numbers)', describeUsage().value === 'Not measured');

// Transport
const relayUdp = { localCandidateType: 'relay', remoteCandidateType: 'host', relayProtocol: 'udp' };
const relayRemote = { localCandidateType: 'srflx', remoteCandidateType: 'relay' };
const direct = { localCandidateType: 'srflx', remoteCandidateType: 'host' };
push('relay local side → Relayed through TURN over UDP', describeTransport(relayUdp, 100, 'aws-ec2').value === 'Relayed through TURN over UDP');
push('relay remote side → Relayed through TURN', describeTransport(relayRemote, 100, 'aws-ec2').value === 'Relayed through TURN');
push('🔴 a direct pair is never called TURN', ! /TURN/.test(describeTransport(direct, 100, 'cloudflare').value) && /^Direct/.test(describeTransport(direct, 100, 'cloudflare').value));
push('🔴 "no inbound UDP" only for Cloudflare + relay', /no inbound UDP/.test(describeTransport(relayUdp, 100, 'cloudflare').hint)
    && ! /UDP/.test(describeTransport(relayUdp, 100, 'aws-ec2').hint));
push('🔴 stale vitals → not measured', describeTransport(relayUdp, VITALS_STALE_MS + 1, 'cloudflare').value === '—');
push('absent vitals → not measured', describeTransport(null, 0, 'cloudflare').value === '—');
push('🔴 one known non-relay side, other absent → unknown, not Direct',
    describeTransport({ localCandidateType: 'host' }, 100, 'aws-ec2').value === '—'
    && describeTransport({ remoteCandidateType: 'srflx' }, 100, 'cloudflare').value === '—');
push('🔴 an unrecognised candidate type → unknown, not Direct',
    describeTransport({ localCandidateType: 'srflx', remoteCandidateType: 'weird' }, 100, 'aws-ec2').value === '—');
push('🔴 known relay on one side with the other absent → still relayed',
    describeTransport({ localCandidateType: 'relay' }, 100, 'aws-ec2').value === 'Relayed through TURN');
push('relay with an unrecognised other side → still relayed',
    describeTransport({ localCandidateType: 'weird', remoteCandidateType: 'relay' }, 100, 'aws-ec2').value === 'Relayed through TURN');
push('prflx + host → Direct', describeTransport({ localCandidateType: 'prflx', remoteCandidateType: 'host' }, 100, 'aws-ec2').value === 'Direct (prflx → host)');
push('vitals without a route → not reported yet', /not reported its route/.test(describeTransport({ rttMs: 30 }, 100, 'aws-ec2').hint));

// Screen errors
push('starting', describeScreenError('UPSTREAM', 'screen_starting') === 'the desktop is still starting');
push('aws starting', describeScreenError('UPSTREAM', 'aws_origin_starting') === 'the desktop is still starting');
push('aws tunnel down', /connection to the desktop service/.test(describeScreenError('UPSTREAM', 'aws_origin_unavailable: generation mismatch')));
push('login failed', describeScreenError('UPSTREAM', 'screen_login_failed_401: neko said no') === 'the desktop refused the stream login');
push('worker http', describeScreenError('UPSTREAM', 'worker_http_502') === 'the desktop service answered HTTP 502');
push('🔴 unknown upstream text is NOT echoed; only the code', describeScreenError('UPSTREAM', '<html>secret internal 10.0.0.5 trace</html>') === 'upstream');
push('🔴 a known token\'s detail is not echoed', ! /generation mismatch/.test(describeScreenError('UPSTREAM', 'aws_origin_unavailable: generation mismatch')));
push('no code, no message → unavailable', describeScreenError(undefined, undefined) === 'unavailable');

let failed = 0;
for ( const r of results ) {
    if ( ! r.ok ) failed++;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  ${JSON.stringify(r.detail ?? '')}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
