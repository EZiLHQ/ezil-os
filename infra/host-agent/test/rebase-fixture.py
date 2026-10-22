#!/usr/bin/env python3
"""Local A/BC wire double for privileged tests (contract v1 names and ordering)."""
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys


def authority(d, offset=0):
    now = datetime.now(timezone.utc) + timedelta(seconds=offset)
    fmt = lambda value: value.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return dict(v=1, preparationJobId='33333333-3333-4333-8333-333333333333',
                launchJobId='44444444-4444-4444-8444-444444444444',
                computerId=d['computerId'], fsUuid=d['fsUuid'], generation=d['generation'],
                leaseEpoch=d['leaseEpoch'], fenceToken='55555555-5555-4555-8555-555555555555',
                issuedAt=fmt(now), expiresAt=fmt(now + timedelta(seconds=600)))


def main(args):
    mode, path, *extra = args
    p = Path(path)
    d = json.loads(p.read_text())
    if mode == 'permit':
        d['rebasePermit'] = authority(d, int(extra[0]) if extra else 0)
    elif mode == 'rebind':
        original, digest, generation, epoch = extra
        a = authority(d)
        d['ebsRestore'] = dict(v=1, preparationJobId=a['preparationJobId'],
            recoveryJobId='66666666-6666-4666-8666-666666666666', launchJobId=a['launchJobId'],
            snapshotId='snap-0123456789abcdef0', originalVolumeId=original, volumeId=d['volumeId'],
            computerId=d['computerId'], fsUuid=d['fsUuid'], fromDigest=digest,
            sourceGeneration=int(generation), sourceLeaseEpoch=int(epoch), generation=d['generation'],
            leaseEpoch=d['leaseEpoch'], fenceToken=a['fenceToken'], issuedAt=a['issuedAt'],
            expiresAt=a['expiresAt'], maintenance=True)
    else:
        raise SystemExit('unknown fixture mode')
    p.write_text(json.dumps(d, separators=(',', ':')))


if __name__ == '__main__':
    main(sys.argv[1:])
