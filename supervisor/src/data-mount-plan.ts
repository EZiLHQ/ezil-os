import { z } from 'zod';
import { verifyDataVolumeEvidence } from './data-volume.js';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
export const DATA_MOUNT = '/srv/ezil-data';
export const DATA_BYTES = 50 * 1024 ** 3;
/** Root-owned controller input, never a publisher/application request. The
 * controller must verify attachment, encryption and writer fencing separately.
 * initialize is explicit first-use authority; mount can never format a disk. */
export const DataMountPlanSchema = z.object({ schemaVersion: z.literal(1), computerId: uuid,
    volumeId: z.string().regex(/^vol-[a-f0-9]{17}$/), filesystemUuid: uuid,
    mode: z.enum(['initialize', 'mount']) }).strict();
export type DataMountPlan = z.infer<typeof DataMountPlanSchema>;
export const FormatAttemptSchema = z.object({ schemaVersion: z.literal(1), computerId: uuid,
    volumeId: z.string().regex(/^vol-[a-f0-9]{17}$/), filesystemUuid: uuid }).strict();
export const formatIdentity = ({ computerId, volumeId, filesystemUuid }: DataMountPlan) => ({ schemaVersion: 1 as const, computerId, volumeId, filesystemUuid });
const row = z.object({ name: z.string(), kname: z.string(), type: z.string(), size: z.number().int().nonnegative(),
    ro: z.boolean(), fstype: z.string().nullable(), uuid: z.string().nullable(), pkname: z.string().nullable(), serial: z.string().nullable(),
    mountpoints: z.array(z.string().nullable()).max(128), 'maj:min': z.string().regex(/^\d+:\d+$/) }).strict();
export type BlockDevice = z.infer<typeof row>;
export const BlockInventorySchema = z.object({ blockdevices: z.array(row).min(1).max(256) }).strict();
const fail = (): never => { throw new Error('data_mount_unconfirmed'); };

/** Resolve the EBS serial, not a caller-selected /dev path or changing NVMe
 * enumeration. Only an unpartitioned Nitro data disk can satisfy this profile. */
export function resolveDataDevice(plan: DataMountPlan, inventory: unknown): BlockDevice {
    const rows = BlockInventorySchema.parse(inventory).blockdevices;
    if (new Set(rows.map(r => r.name)).size !== rows.length || new Set(rows.map(r => r['maj:min'])).size !== rows.length) return fail();
    const roots = rows.filter(r => r.mountpoints.includes('/'));
    if (roots.length !== 1) return fail();
    const rootChain = new Set<string>(); let root: BlockDevice | undefined = roots[0];
    while (root) {
        if (rootChain.has(root.name)) return fail(); rootChain.add(root.name);
        if (!root.pkname) break;
        root = rows.find(r => r.name === root!.pkname || r.kname === root!.pkname);
        if (!root) return fail();
    }
    const matches = rows.filter(r => r.serial?.trim() === plan.volumeId.replace('-', ''));
    if (matches.length !== 1) return fail();
    const d = matches[0]!;
    if (!/^\/dev\/nvme[0-9]+n[0-9]+$/.test(d.name) || d.kname !== d.name || d.type !== 'disk' || d.pkname
        || d.ro || d.size !== DATA_BYTES || rootChain.has(d.name)
        || rows.some(r => r.pkname === d.name || r.pkname === d.kname)
        || rows.some(r => r.name !== d.name && r.mountpoints.includes(DATA_MOUNT))) return fail();
    if (d.mountpoints.some(p => p !== null && p !== DATA_MOUNT)) return fail();
    return d;
}

export function decideDataMount(plan: DataMountPlan, d: BlockDevice, evidence: { mountInfo: string; marker: string | null; attempt: unknown }) {
    const mounted = evidence.mountInfo.split('\n').filter(line => line.split(' ')[4] === DATA_MOUNT);
    const attempt = evidence.attempt === null ? null : FormatAttemptSchema.parse(evidence.attempt);
    if (attempt && JSON.stringify(attempt) !== JSON.stringify(formatIdentity(plan))) return fail();
    if (d.fstype === null && d.uuid === null) {
        if (mounted.length || d.mountpoints.some(Boolean) || plan.mode !== 'initialize' || attempt) return fail();
        return 'initialize' as const;
    }
    if (d.fstype !== 'ext4' || d.uuid !== plan.filesystemUuid) return fail();
    if (!mounted.length) {
        if (d.mountpoints.some(Boolean)) return fail();
        return 'mount' as const;
    }
    const fields = mounted[0]!.split(' ');
    if (mounted.length !== 1 || fields[2] !== d['maj:min'] || fields[3] !== '/' || !d.mountpoints.includes(DATA_MOUNT)) return fail();
    if (mounted[0]!.split(' - ')[1]?.split(' ')[0] !== 'ext4'
        || !['rw', 'nosuid', 'nodev'].every(option => fields[5]?.split(',').includes(option))) return fail();
    if (evidence.marker === null) {
        if (plan.mode !== 'initialize' || !attempt) return fail();
        return 'mark' as const;
    }
    if (!verifyDataVolumeEvidence(DATA_MOUNT, plan, evidence.mountInfo, evidence.marker).ok) return fail();
    return 'ready' as const;
}
