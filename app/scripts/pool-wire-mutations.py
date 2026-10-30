#!/usr/bin/env python3
"""Offline POOL-WIRE mutation audit. Restores each original before proceeding."""
from pathlib import Path
import subprocess, os, sys
app = Path(__file__).resolve().parents[1]
base = app/'src/server/lib/compute'
cases = []
for file, names in [('aws-pool-dispatch.ts', ['dispatch_work_binding','dispatch_capacity','dispatch_reserved','dispatch_host','dispatch_operation','dispatch_saved','dispatch_execution','dispatch_receipt']), ('aws-pool-session.ts', ['session_health','session_claim','session_binding','session_tags','session_pending','session_finished'])]:
    for name in names:
        before = "poolGuard('"+name+"', "
        cases.append((name, base/file, before, before+'true || '))
for key in ['computerId','jobId','digest','leaseEpoch','poolGeneration','operation']:
    before = {'digest':'a.digest === w.digest', 'poolGeneration':'a.poolGeneration === i.poolGeneration'}.get(key, 'a.'+key+' === i.'+key)
    cases.append(('authority-'+key, base/'aws-pool-dispatch.ts', before, 'true'))
cases += [
 ('session-timestamp', base/'aws-pool-session.ts', "poolGuard('session_timestamp', ", "poolGuard('session_timestamp', true || "),
 ('durable-billing-time', base/'aws-receipts.ts', 'deps.pool.readyAt ? await deps.pool.readyAt(deps.db, poolWork.poolHostId!, p) : enrollmentReadyAt', 'enrollmentReadyAt'),
 ('timestamp-immutable', base/'ready-pool.ts', 'AND session_ready_at IS NULL RETURNING id', 'RETURNING id'),
 ('timestamp-valid', base/'ready-pool.ts', 'at && Number.isFinite(at.getTime()) ? at : null', 'at'),
 ('open-capacity', base/'aws-pool-runtime.ts', "poolGuard('open_pool_capacity', ", "poolGuard('open_pool_capacity', true || "),
 ('post-bind-capacity', base/'aws-ec2.ts', 'await deps.pool?.validateCapacity?.(tx, p);', 'void p;'),
 ('booting-reservation', base/'aws-pool-dispatch.ts', "'booting', 'unknown', now()", "'ready', 'unknown', now()"),
 ('generation-reservation', base/'aws-pool-dispatch.ts', 'VALUES (${id}::uuid, 1,', 'VALUES (${id}::uuid, 2,'),
 ('release-epoch', base/'ready-pool.ts', 'AND claim_lease_epoch = ${p.leaseEpoch}', ''),
 ('nonce-epoch', base/'placement.ts', 'AND generation = ${p.generation} AND lease_epoch = ${p.leaseEpoch}\n            AND instance_id', 'AND instance_id'),
 ('p8-lease', base/'aws-pool-runtime.ts', 'leasePoolHost: poolModule.leasePoolHost', 'leasePoolHost: poolModule.publishPoolClaim'),
 ('p8-publish', base/'aws-pool-runtime.ts', 'publishPoolClaim: poolModule.publishPoolClaim', 'publishPoolClaim: poolModule.leasePoolHost'),
 ('immediate-replenish', base/'aws-pool-runtime.ts', 'await runPoolReplenish(createPoolReplenishDeps(db, env));', 'return;'),
 ('authority-state', base/'aws-pool-dispatch.ts', "row.state === 'booting'", 'true'),
 ('authority-kill', base/'aws-pool-dispatch.ts', "env.EZIL_AWS_KILL_SWITCH !== '1'", 'true'),
 ('authority-unleased', base/'aws-pool-dispatch.ts', 'row.leased_computer_id === null', 'true'),
 ('retire-known', base/'aws-pool-dispatch.ts', "found[0]!.instance_id !== null", 'true'),
 ('retire-settled', base/'aws-pool-dispatch.ts', "found[0]!.dispatch_status === 'settled'", 'true'),
 ('nonce-handoff', base/'aws-ec2.ts', 'enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null };', 'enrollConsumedHash: null, enrollExpiresAt: null };'),
 ('enrollment-delay', base/'placement.ts', 'input.poolClaim && !input.sessionReady ? POOL_SESSION_PENDING : ENROLLMENT_SUCCEEDED', 'ENROLLMENT_SUCCEEDED'),
 ('session-replay', base/'aws-pool-session.ts', 'if (p.lastError === ENROLLMENT_SUCCEEDED) return;', 'if (false) return;'),
 ('blank-claim-authority', base/'aws-pool-claim.ts', 'createVolume: true, fsUuid: p.fsUuid', 'createVolume: false, fsUuid: p.fsUuid'),
 ('relay-pending', base/'aws-preview.ts', 'p.lastError === POOL_SESSION_PENDING &&', 'true &&'),
 ('relay-consumed', base/'aws-preview.ts', 'p.enrollConsumedHash !== null', 'true'),
 ('instance-claim-tags', base/'aws-enroll.ts', '!carries(view.tags, instanceTags)', 'false'),
 ('root-device-bytes', base/'aws-intent.ts', "rootDeviceName: '/dev/sda1'", "rootDeviceName: '/dev/xvda'"),
]
cmd = ['node', 'node_modules/vitest/vitest.mjs', 'run', '--no-cache', '--configLoader', 'runner',
 'src/server/lib/compute/aws-pool-wire.test.ts', 'src/server/lib/compute/aws-ec2.pool.test.ts',
 'src/server/lib/compute/aws-preview.test.ts', 'src/server/lib/compute/aws-enroll-endpoint.test.ts',
 'src/server/lib/compute/aws-intent.pool.test.ts', 'src/app/api/internal/computers/lifecycle-authority']
env = {**os.environ, 'npm_config_offline':'true'}
failed=[]
selected = [c for c in cases if not sys.argv[1:] or c[0] in sys.argv[1:]]
for name,path,before,after in selected:
    original=path.read_text()
    if before not in original: raise RuntimeError('missing anchor '+name)
    try:
        path.write_text(original.replace(before,after,1))
        result=subprocess.run(cmd,cwd=app,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=60)
        killed=result.returncode!=0 and ' FAIL ' in result.stdout and 'AssertionError' in result.stdout
        print(('KILLED ' if killed else 'SURVIVED ')+name,flush=True)
        if not killed:
            failed.append(name); Path('/tmp/pool-wire-mutant-'+name+'.log').write_text(result.stdout)
    finally: path.write_text(original)
print(f'Pool wiring mutations: {len(selected)-len(failed)} killed, {len(failed)} survived',flush=True)
sys.exit(bool(failed))
