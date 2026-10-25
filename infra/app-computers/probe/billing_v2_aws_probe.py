#!/usr/bin/env python3
"""Billing v2 AWS capability probe (request os-billing-compute-20261018-v2).

A bounded, tagged, direct-EC2 measurement of the primitives billing v2 relies
on. It is NOT a product lifecycle end-to-end run: the product lifecycle needs
the app's lifecycle-authority endpoint on a deployment backed by the production
database, which is out of scope. Everything this creates carries the tag
`ezil:probe=<run id>` and is removed by `cleanup`.

Measured rows:
  A  cold boot (Mumbai, std-2 m6i.large): RunInstances -> guest boot line -> data disk ready
  B  warm attach (the ready-pool primitive): a running clean host gets a user's
     encrypted disk attached -> guest "data ready" with the user's marker
  C  size transitions with persistence: stop -> m6i.xlarge (cmp-4) -> start ->
     m6i.2xlarge (cmp-8) -> start; the marker must survive, nproc/mem must match
  D  regional recovery: snapshot the Mumbai disk (RPO point) -> fence the Mumbai
     writer (stopped + tagged generation) -> copy the snapshot to us-east-1
     (re-encrypted with the destination's default EBS key) -> volume -> attach to
     a US host -> marker verified (RTO measured from "outage declared")
  E  cleanup verified: no tagged instance, volume or snapshot left in either region

Safety:
  - profile ezil-admin only; refuses the default profile and root
  - running estimate checked before every launch; aborts above --budget-usd (default 10)
  - instances: no public IP, IMDSv2 required, InstanceInitiatedShutdownBehavior=terminate,
    and the guest schedules `shutdown -h +40` as a backstop
  - volumes encrypted with the region's default EBS key; no new KMS key, IAM role or SG

Usage:
  python3 billing_v2_aws_probe.py run   [--budget-usd 10] [--out <dir>]
  python3 billing_v2_aws_probe.py cleanup --run-id <id>
  python3 billing_v2_aws_probe.py sweep        # list anything tagged ezil:purpose=billing-v2-probe
"""
import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone, timedelta

PROFILE = 'ezil-admin'
PRIMARY = 'ap-south-1'
FAILOVER = 'us-east-1'
AMI_PARAM = '/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id'
PURPOSE = 'billing-v2-probe'
OWNER = 'os-billing-compute-20261018-v2'
HOURLY = {  # on-demand USD/h, AWS EC2 offer CSV effective 2026-10-01 (docs/billing/economics/rates.json)
    (PRIMARY, 'm6i.large'): 0.101, (PRIMARY, 'm6i.xlarge'): 0.202, (PRIMARY, 'm6i.2xlarge'): 0.404,
    (FAILOVER, 'm6i.large'): 0.096, (FAILOVER, 'm6i.xlarge'): 0.192, (FAILOVER, 'm6i.2xlarge'): 0.384,
}
SIZE_FOR = {'m6i.large': ('std-2', 2, 8), 'm6i.xlarge': ('cmp-4', 4, 16), 'm6i.2xlarge': ('cmp-8', 8, 32)}
DATA_GB = 8

# Runs on EVERY boot (cloud-boothook). Reports to the serial console, which the
# probe reads with GetConsoleOutput --latest. No network access is needed.
USER_DATA = r'''#cloud-boothook
#!/bin/bash
exec >/dev/console 2>&1
shutdown -h +40 "ezil billing-v2 probe backstop" || true
now() { date +%s.%N; }
echo "EZIL_PROBE {\"event\":\"boot\",\"t\":$(now),\"uptime\":$(cut -d' ' -f1 /proc/uptime),\"nproc\":$(nproc),\"memkb\":$(awk '/MemTotal/{print $2}' /proc/meminfo)}"
cat > /var/lib/ezil-probe-watch.sh <<'WATCH'
#!/bin/bash
exec >/dev/console 2>&1
now() { date +%s.%N; }
  seen=""
  # Nitro may enumerate the root disk as any nvmeXn1 after a stop/start: never pick it.
  rootdisk=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)" 2>/dev/null | head -1)
  for i in $(seq 1 2400); do
    dev=""
    for d in /dev/nvme[0-9]n1; do
      [ -b "$d" ] || continue
      [ "$(basename "$d")" = "$rootdisk" ] && continue
      dev="$d"; break
    done
    if [ -n "$dev" ]; then
      serial=$(cat /sys/block/$(basename $dev)/device/serial 2>/dev/null | tr -d ' ')
      if [ "$serial" != "$seen" ]; then
        mkdir -p /mnt/data
        new=false
        if ! blkid "$dev" >/dev/null 2>&1; then mkfs.ext4 -q -L ezildata "$dev"; new=true; fi
        mount "$dev" /mnt/data 2>/dev/null || true
        if [ ! -f /mnt/data/ezil-marker ]; then
          cat /proc/sys/kernel/random/uuid > /mnt/data/ezil-marker; sync
        fi
        echo "EZIL_PROBE {\"event\":\"data_ready\",\"t\":$(now),\"serial\":\"$serial\",\"dev\":\"$dev\",\"rootdisk\":\"$rootdisk\",\"new_fs\":$new,\"marker\":\"$(cat /mnt/data/ezil-marker)\",\"nproc\":$(nproc),\"memkb\":$(awk '/MemTotal/{print $2}' /proc/meminfo)}"
        seen="$serial"
      fi
    elif [ -n "$seen" ]; then
      umount -l /mnt/data 2>/dev/null || true
      echo "EZIL_PROBE {\"event\":\"data_gone\",\"t\":$(now),\"serial\":\"$seen\"}"
      seen=""
    fi
    sleep 0.5
  done
WATCH
chmod +x /var/lib/ezil-probe-watch.sh
setsid nohup /var/lib/ezil-probe-watch.sh >/dev/null 2>&1 < /dev/null &
'''


def aws(region, *args, check=True, timeout=180):
    cmd = ['aws', '--profile', PROFILE, '--region', region, '--output', 'json', *args]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError(f'aws {" ".join(args[:2])} failed: {p.stderr.strip()[:400]}')
    return json.loads(p.stdout) if p.stdout.strip() else {}


def poll(fn, what, timeout=900, every=5):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if fn():
            return time.time()
        time.sleep(every)
    raise RuntimeError(f'timeout waiting for {what}')


def volume_state(region, vid):
    out = aws(region, 'ec2', 'describe-volumes', '--volume-ids', vid, check=False)
    v = out.get('Volumes') if isinstance(out, dict) else None
    return v[0]['State'] if v else 'gone'


def wait_volume(region, vid, state, timeout=600):
    return poll(lambda: volume_state(region, vid) == state, f'{vid} {state}', timeout, 2)


def wait_snapshot(region, sid, timeout=3000):
    def done():
        s = aws(region, 'ec2', 'describe-snapshots', '--snapshot-ids', sid)['Snapshots'][0]
        if s['State'] == 'error':
            raise RuntimeError(f'snapshot {sid} failed')
        return s['State'] == 'completed'
    return poll(done, f'snapshot {sid}', timeout, 10)


def wait_terminated(region, ids, timeout=900):
    def done():
        r = aws(region, 'ec2', 'describe-instances', '--instance-ids', *ids)
        return all(i['State']['Name'] == 'terminated' for res in r['Reservations'] for i in res['Instances'])
    return poll(done, 'termination', timeout, 5)


def utc():
    return datetime.now(timezone.utc)


def log(msg, **kw):
    line = {'t': utc().strftime('%Y-%m-%dT%H:%M:%S.%fZ'), 'msg': msg, **kw}
    print(json.dumps(line), flush=True)
    return line


class Budget:
    def __init__(self, limit):
        self.limit = limit
        self.spent_instance_seconds = {}  # (region, type) -> seconds (estimate)
        self.open = {}  # instance id -> (region, type, started_epoch)

    def estimate(self, extra=None):
        total = sum(HOURLY[k] * s / 3600 for k, s in self.spent_instance_seconds.items())
        now = time.time()
        for _, (r, t, start) in self.open.items():
            total += HOURLY[(r, t)] * (now - start) / 3600
        if extra:
            total += HOURLY[extra[0]] * extra[1] / 3600
        return total + 0.05  # EBS, snapshots and copy transfer for a few GB: well under 5 cents

    def guard(self, region, itype, planned_seconds=2400):
        est = self.estimate((( region, itype), planned_seconds))
        if est > self.limit:
            raise RuntimeError(f'budget guard: estimate {est:.2f} > {self.limit}')
        return est


def tags(run_id, extra=None):
    expires = (utc() + timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%SZ')
    t = [{'Key': 'ezil:probe', 'Value': run_id}, {'Key': 'ezil:purpose', 'Value': PURPOSE},
         {'Key': 'ezil:owner', 'Value': OWNER}, {'Key': 'ezil:expires', 'Value': expires}]
    for k, v in (extra or {}).items():
        t.append({'Key': k, 'Value': v})
    return t


def tag_spec(kind, run_id, extra=None):
    return json.dumps([{'ResourceType': kind, 'Tags': tags(run_id, extra)}])


def default_subnet(region):
    subnets = aws(region, 'ec2', 'describe-subnets', '--filters', 'Name=default-for-az,Values=true')['Subnets']
    subnets.sort(key=lambda s: s['AvailabilityZone'])
    return subnets[0]


def launch(region, itype, run_id, budget, name):
    est = budget.guard(region, itype)
    ami = aws(region, 'ssm', 'get-parameter', '--name', AMI_PARAM)['Parameter']['Value']
    subnet = default_subnet(region)
    t0 = time.time()
    out = aws(region, 'ec2', 'run-instances', '--image-id', ami, '--instance-type', itype, '--count', '1',
              '--network-interfaces', json.dumps([{'DeviceIndex': 0, 'SubnetId': subnet['SubnetId'], 'AssociatePublicIpAddress': False}]),
              '--metadata-options', 'HttpTokens=required,HttpPutResponseHopLimit=1,InstanceMetadataTags=disabled',
              '--instance-initiated-shutdown-behavior', 'terminate',
              '--block-device-mappings', json.dumps([{'DeviceName': '/dev/sda1', 'Ebs': {'VolumeSize': 8, 'VolumeType': 'gp3', 'Encrypted': True, 'DeleteOnTermination': True}}]),
              '--user-data', USER_DATA,
              '--tag-specifications', json.dumps([{'ResourceType': 'instance', 'Tags': tags(run_id, {'Name': name})},
                                                  {'ResourceType': 'volume', 'Tags': tags(run_id, {'Name': name + '-root'})}]))
    iid = out['Instances'][0]['InstanceId']
    budget.open[iid] = (region, itype, t0)
    log('launched', region=region, instance=iid, type=itype, az=subnet['AvailabilityZone'], estimate_usd=round(est, 3))
    return iid, subnet['AvailabilityZone'], t0


def console_events(region, iid):
    out = aws(region, 'ec2', 'get-console-output', '--instance-id', iid, '--latest', check=False)
    text = out.get('Output') or ''
    if text and not text.startswith('EZIL') and '\n' not in text[:200]:
        import base64
        try:
            text = base64.b64decode(text).decode(errors='replace')
        except Exception:
            pass
    events = []
    for line in text.splitlines():
        i = line.find('EZIL_PROBE ')
        if i >= 0:
            try:
                events.append(json.loads(line[i + 11:].strip()))
            except ValueError:
                pass
    return events


def wait_event(region, iid, pred, timeout=900, since=0.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        for e in console_events(region, iid):
            if e.get('t', 0) >= since and pred(e):
                return e
        time.sleep(3)
    raise RuntimeError(f'timeout waiting for console event on {iid}')


def wait_state(region, iid, state, timeout=600):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = aws(region, 'ec2', 'describe-instances', '--instance-ids', iid)
        s = r['Reservations'][0]['Instances'][0]['State']['Name']
        if s == state:
            return time.time()
        time.sleep(2)
    raise RuntimeError(f'{iid} did not reach {state}')


def create_volume(region, az, run_id, name, snapshot=None):
    args = ['ec2', 'create-volume', '--availability-zone', az, '--volume-type', 'gp3', '--encrypted',
            '--tag-specifications', tag_spec('volume', run_id, {'Name': name})]
    args += ['--snapshot-id', snapshot] if snapshot else ['--size', str(DATA_GB)]
    vid = aws(region, *args)['VolumeId']
    wait_volume(region, vid, 'available')
    return vid


def attach(region, vid, iid):
    t = time.time()
    aws(region, 'ec2', 'attach-volume', '--volume-id', vid, '--instance-id', iid, '--device', '/dev/sdf')
    return t


def serial_of(vid):
    return vid.replace('-', '')


def run(args):
    ident = aws(PRIMARY, 'sts', 'get-caller-identity')
    if ident['Arn'].endswith(':root'):
        raise SystemExit('refusing to run as root')
    run_id = 'bv2-' + utc().strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:6]
    budget = Budget(args.budget_usd)
    results = {'run_id': run_id, 'identity_arn': ident['Arn'], 'started': utc().isoformat(), 'rows': {}}
    log('start', run_id=run_id, arn=ident['Arn'], budget_usd=args.budget_usd)
    try:
        # A: cold boot in Mumbai at std-2 with a fresh user disk attached after boot.
        iid, az, t_launch = launch(PRIMARY, 'm6i.large', run_id, budget, 'bv2-mumbai-std2')
        t_running = wait_state(PRIMARY, iid, 'running')
        boot = wait_event(PRIMARY, iid, lambda e: e['event'] == 'boot')
        vol = create_volume(PRIMARY, az, run_id, 'bv2-user-disk')
        t_att = attach(PRIMARY, vol, iid)
        ready = wait_event(PRIMARY, iid, lambda e: e['event'] == 'data_ready' and e['serial'] == serial_of(vol))
        marker = ready['marker']
        results['rows']['A_cold_boot_mumbai_std2'] = {
            'instance': iid, 'type': 'm6i.large', 'run_to_running_s': round(t_running - t_launch, 1),
            'run_to_guest_boot_s': round(boot['t'] - t_launch, 1), 'guest_nproc': boot['nproc'], 'guest_memkb': boot['memkb'],
            'attach_to_data_ready_s': round(ready['t'] - t_att, 1), 'new_fs': ready['new_fs'],
            'note': 'guest boot = first init-script line; product desktop/editor readiness is NOT measured here'}
        log('row A', **results['rows']['A_cold_boot_mumbai_std2'])

        # B: warm attach — detach the user disk, re-attach to the SAME running clean host (pool lease primitive).
        aws(PRIMARY, 'ec2', 'detach-volume', '--volume-id', vol)
        wait_volume(PRIMARY, vol, 'available')
        t_att2 = attach(PRIMARY, vol, iid)
        ready2 = wait_event(PRIMARY, iid, lambda e: e['event'] == 'data_ready' and e['serial'] == serial_of(vol), since=t_att2 - 5)
        results['rows']['B_warm_attach_mumbai'] = {
            'attach_to_data_ready_s': round(ready2['t'] - t_att2, 1), 'marker_preserved': ready2['marker'] == marker,
            'note': 'warm path = pre-booted clean host + attach + mount; excludes tunnel/desktop start'}
        log('row B', **results['rows']['B_warm_attach_mumbai'])

        # C: size transitions with persistence: std-2 -> cmp-4 -> cmp-8.
        transitions = []
        for itype in ('m6i.xlarge', 'm6i.2xlarge'):
            budget.guard(PRIMARY, itype, 900)
            t_stop = time.time()
            aws(PRIMARY, 'ec2', 'stop-instances', '--instance-ids', iid)
            t_stopped = wait_state(PRIMARY, iid, 'stopped')
            r, prev_t, start = budget.open[iid]
            budget.spent_instance_seconds[(r, prev_t)] = budget.spent_instance_seconds.get((r, prev_t), 0) + (t_stopped - start)
            aws(PRIMARY, 'ec2', 'modify-instance-attribute', '--instance-id', iid, '--instance-type', json.dumps({'Value': itype}))
            t_start = time.time()
            aws(PRIMARY, 'ec2', 'start-instances', '--instance-ids', iid)
            budget.open[iid] = (PRIMARY, itype, t_start)
            boot2 = wait_event(PRIMARY, iid, lambda e: e['event'] == 'boot', since=t_start - 5)
            ready3 = wait_event(PRIMARY, iid, lambda e: e['event'] == 'data_ready' and e['serial'] == serial_of(vol), since=t_start - 5)
            size, vcpu, gib = SIZE_FOR[itype]
            row = {'to': itype, 'size': size, 'stop_s': round(t_stopped - t_stop, 1),
                   'start_to_guest_boot_s': round(boot2['t'] - t_start, 1), 'start_to_data_ready_s': round(ready3['t'] - t_start, 1),
                   'guest_nproc': ready3['nproc'], 'nproc_ok': ready3['nproc'] == vcpu,
                   'guest_memgib': round(ready3['memkb'] / 1048576, 1), 'marker_preserved': ready3['marker'] == marker}
            transitions.append(row)
            log('row C step', **row)
        results['rows']['C_size_transitions_mumbai'] = transitions

        # D: regional recovery Mumbai -> US with the old writer fenced first.
        t_outage = time.time()
        snap = aws(PRIMARY, 'ec2', 'create-snapshot', '--volume-id', vol, '--description', f'ezil billing-v2 probe {run_id}',
                   '--tag-specifications', tag_spec('snapshot', run_id, {'Name': 'bv2-rpo-point'}))
        snap_id, rpo_point = snap['SnapshotId'], snap['StartTime']
        aws(PRIMARY, 'ec2', 'stop-instances', '--instance-ids', iid)            # fence: the writer is stopped
        t_fenced = wait_state(PRIMARY, iid, 'stopped')
        r, prev_t, start = budget.open.pop(iid)
        budget.spent_instance_seconds[(r, prev_t)] = budget.spent_instance_seconds.get((r, prev_t), 0) + (t_fenced - start)
        aws(PRIMARY, 'ec2', 'create-tags', '--resources', vol, '--tags', 'Key=ezil:fenced-generation,Value=1')
        wait_snapshot(PRIMARY, snap_id)
        t_snap_done = time.time()
        copy = aws(FAILOVER, 'ec2', 'copy-snapshot', '--source-region', PRIMARY, '--source-snapshot-id', snap_id, '--encrypted',
                   '--description', f'ezil billing-v2 probe {run_id} copy',
                   '--tag-specifications', tag_spec('snapshot', run_id, {'Name': 'bv2-us-replica'}))
        us_snap = copy['SnapshotId']
        us_iid, us_az, t_us_launch = launch(FAILOVER, 'm6i.large', run_id, budget, 'bv2-us-recovery')
        wait_snapshot(FAILOVER, us_snap)
        t_copy_done = time.time()
        us_vol = create_volume(FAILOVER, us_az, run_id, 'bv2-us-restored', snapshot=us_snap)
        wait_state(FAILOVER, us_iid, 'running')
        wait_event(FAILOVER, us_iid, lambda e: e['event'] == 'boot')
        t_us_att = attach(FAILOVER, us_vol, us_iid)
        us_ready = wait_event(FAILOVER, us_iid, lambda e: e['event'] == 'data_ready' and e['serial'] == serial_of(us_vol))
        results['rows']['D_regional_recovery_mumbai_to_us'] = {
            'rpo_point': rpo_point, 'mumbai_writer_fenced_s': round(t_fenced - t_outage, 1),
            'snapshot_complete_s': round(t_snap_done - t_outage, 1), 'cross_region_copy_s': round(t_copy_done - t_snap_done, 1),
            'us_attach_to_data_ready_s': round(us_ready['t'] - t_us_att, 1),
            'rto_outage_to_us_data_ready_s': round(us_ready['t'] - t_outage, 1),
            'marker_preserved': us_ready['marker'] == marker, 'new_fs_in_us': us_ready['new_fs'],
            'note': 'data written after the snapshot start is NOT in the replica (RPO = snapshot point); fencing here = writer stopped before restore'}
        log('row D', **results['rows']['D_regional_recovery_mumbai_to_us'])
    finally:
        results['estimated_spend_usd'] = round(budget.estimate(), 3)
        try:
            results['cleanup'] = cleanup_run(run_id)
        except Exception as error:  # keep the measured rows even if cleanup needs a second pass
            results['cleanup'] = {'error': str(error)[:400], 'next': f'python3 billing_v2_aws_probe.py cleanup --run-id {run_id}'}
        results['finished'] = utc().isoformat()
        if args.out:
            os.makedirs(args.out, exist_ok=True)
            with open(os.path.join(args.out, f'{run_id}.json'), 'w') as f:
                json.dump(results, f, indent=2)
        log('done', run_id=run_id, estimated_spend_usd=results['estimated_spend_usd'], cleanup=results['cleanup'])
    return results


def tagged(region, run_id=None):
    f = [f'Name=tag:ezil:purpose,Values={PURPOSE}'] + ([f'Name=tag:ezil:probe,Values={run_id}'] if run_id else [])
    inst = [i for r in aws(region, 'ec2', 'describe-instances', '--filters', *f)['Reservations'] for i in r['Instances']
            if i['State']['Name'] not in ('terminated',)]
    vols = aws(region, 'ec2', 'describe-volumes', '--filters', *f)['Volumes']
    snaps = aws(region, 'ec2', 'describe-snapshots', '--owner-ids', 'self', '--filters', *f)['Snapshots']
    return inst, vols, snaps


def cleanup_run(run_id):
    report = {}
    for region in (PRIMARY, FAILOVER):
        inst, vols, snaps = tagged(region, run_id)
        ids = [i['InstanceId'] for i in inst]
        if ids:
            aws(region, 'ec2', 'terminate-instances', '--instance-ids', *ids)
            wait_terminated(region, ids)
        # Root disks die with their instance; re-list after termination and act only on what is left.
        for v in aws(region, 'ec2', 'describe-volumes', '--filters', f'Name=tag:ezil:probe,Values={run_id}')['Volumes']:
            if v['State'] == 'in-use':
                aws(region, 'ec2', 'detach-volume', '--volume-id', v['VolumeId'], '--force', check=False)
                poll(lambda vid=v['VolumeId']: volume_state(region, vid) in ('available', 'gone'), f"{v['VolumeId']} detach", 600, 2)
        for v in aws(region, 'ec2', 'describe-volumes', '--filters', f'Name=tag:ezil:probe,Values={run_id}')['Volumes']:
            aws(region, 'ec2', 'delete-volume', '--volume-id', v['VolumeId'], check=False)
        for s in snaps:
            aws(region, 'ec2', 'delete-snapshot', '--snapshot-id', s['SnapshotId'], check=False)
        time.sleep(5)
        inst2, vols2, snaps2 = tagged(region, run_id)
        report[region] = {'terminated': ids, 'volumes_deleted': [v['VolumeId'] for v in vols],
                          'snapshots_deleted': [s['SnapshotId'] for s in snaps],
                          'remaining': {'instances': [i['InstanceId'] for i in inst2 if i['State']['Name'] != 'shutting-down'],
                                        'volumes': [v['VolumeId'] for v in vols2], 'snapshots': [s['SnapshotId'] for s in snaps2]}}
    return report


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('run'); r.add_argument('--budget-usd', type=float, default=10.0); r.add_argument('--out')
    c = sub.add_parser('cleanup'); c.add_argument('--run-id', required=True)
    sub.add_parser('sweep')
    a = p.parse_args()
    if a.cmd == 'run':
        run(a)
    elif a.cmd == 'cleanup':
        print(json.dumps(cleanup_run(a.run_id), indent=2))
    else:
        for region in (PRIMARY, FAILOVER):
            inst, vols, snaps = tagged(region)
            print(json.dumps({'region': region, 'instances': [(i['InstanceId'], i['State']['Name']) for i in inst],
                              'volumes': [v['VolumeId'] for v in vols], 'snapshots': [s['SnapshotId'] for s in snaps]}))


if __name__ == '__main__':
    main()
