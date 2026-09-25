import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const VOLUME_ID = /^vol-[a-f0-9]{8}(?:[a-f0-9]{9})?$/;
const MARKER = '.ezil-volume.json';

export type VolumeIdentity = { computerId: string; volumeId: string };
export type VolumeAdmission = { ok: true } | { ok: false; code:
    'invalid_volume_configuration' | 'mountinfo_unavailable' | 'data_mount_missing'
    | 'data_mount_readonly' | 'data_mount_unsupported' | 'data_marker_invalid'
    | 'data_volume_mismatch' };

function validConfiguration(mountPoint: string, identity: VolumeIdentity): boolean {
    return isAbsolute(mountPoint) && mountPoint !== '/' && normalize(mountPoint) === mountPoint
        && !/[\x00-\x20\x7f]/.test(mountPoint) && UUID.test(identity.computerId)
        && VOLUME_ID.test(identity.volumeId);
}

/** Check Linux's observed mount table, not the existence of a directory. This
 * does not establish encryption, EBS attachment ownership or writer fencing;
 * those remain mandatory controller checks before this host may run apps. */
export function verifyDataVolumeEvidence(
    mountPoint: string,
    expected: VolumeIdentity,
    mountInfo: string,
    markerJson: string,
): VolumeAdmission {
    if (!validConfiguration(mountPoint, expected)) return { ok: false, code: 'invalid_volume_configuration' };
    const mounts = mountInfo.split('\n').flatMap((line) => {
        const [before, after] = line.split(' - ');
        if (!before || !after) return [];
        const fields = before.split(' ');
        const filesystem = after.split(' ');
        return fields[4] === mountPoint ? [{ fields, filesystem }] : [];
    });
    // Stacked mounts at the same point are ambiguous. A data mount must be the
    // filesystem root, not a bind of a directory on the disposable root disk.
    if (mounts.length !== 1) return { ok: false, code: 'data_mount_missing' };
    const mount = mounts[0]!;
    if (mount.fields[3] !== '/' || !['ext4', 'xfs'].includes(mount.filesystem[0] ?? '')) {
        return { ok: false, code: 'data_mount_unsupported' };
    }
    if (!mount.fields[5]?.split(',').includes('rw') || !mount.filesystem[2]?.split(',').includes('rw')) {
        return { ok: false, code: 'data_mount_readonly' };
    }
    let marker: unknown;
    try { marker = JSON.parse(markerJson); } catch { return { ok: false, code: 'data_marker_invalid' }; }
    if (!marker || typeof marker !== 'object' || Array.isArray(marker)) {
        return { ok: false, code: 'data_marker_invalid' };
    }
    const value = marker as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'computerId,schemaVersion,volumeId'
        || value.schemaVersion !== 1 || typeof value.computerId !== 'string'
        || !UUID.test(value.computerId) || typeof value.volumeId !== 'string' || !VOLUME_ID.test(value.volumeId)) {
        return { ok: false, code: 'data_marker_invalid' };
    }
    if (value.computerId !== expected.computerId || value.volumeId !== expected.volumeId) {
        return { ok: false, code: 'data_volume_mismatch' };
    }
    return { ok: true };
}

async function readBoundedRegularFile(path: string, limit: number): Promise<string> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > limit) throw new Error('invalid_volume_evidence');
        // procfs reports zero size, so bound the read as well as the stat.
        const buffer = Buffer.alloc(limit + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
            if (!bytesRead) break;
            offset += bytesRead;
        }
        if (offset > limit) throw new Error('invalid_volume_evidence');
        return buffer.subarray(0, offset).toString('utf8');
    } finally { await file.close(); }
}

/** Call at the point of starting a service. Missing, symlinked, malformed or
 * mismatched evidence returns a stable code without echoing paths or values. */
export async function admitMountedDataVolume(
    mountPoint: string,
    expected: VolumeIdentity,
    mountInfoPath = '/proc/self/mountinfo',
): Promise<VolumeAdmission> {
    if (!validConfiguration(mountPoint, expected)) return { ok: false, code: 'invalid_volume_configuration' };
    let mountInfo: string;
    try { mountInfo = await readBoundedRegularFile(mountInfoPath, 1024 * 1024); }
    catch { return { ok: false, code: 'mountinfo_unavailable' }; }
    let marker: string;
    try {
        const stat = await lstat(mountPoint);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, code: 'data_mount_missing' };
        marker = await readBoundedRegularFile(join(mountPoint, MARKER), 2048);
    } catch { return { ok: false, code: 'data_marker_invalid' }; }
    return verifyDataVolumeEvidence(mountPoint, expected, mountInfo, marker);
}
