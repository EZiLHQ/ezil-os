import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from './control-protocol.js';
import { ensureHostDirectory, readHostFile } from './host-config.js';
import { openHostDirectory } from './mounts.js';
import { ProvisioningSchema } from './configuration-delivery-contract.js';
import { DataMountAuthorizationSchema, DataMountDeliverySchema, validateDataMountDelivery } from './data-mount-delivery-contract.js';

export const MountRecordsSchema = z.object({ provisioning: ProvisioningSchema, authorization: DataMountAuthorizationSchema,
    delivery: DataMountDeliverySchema }).strict().refine(r => {
    try { validateDataMountDelivery(r.delivery, r.provisioning, r.authorization, r.authorization.issuedAt * 1000); return true; }
    catch { return false; }
}, 'invalid_mount_records');
export type MountRecords = z.infer<typeof MountRecordsSchema>;
export async function optionalProtected(path: string) {
    try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
    return readHostFile(path, 16384);
}
/** Exclusive fsynced records. A partial prior write is ambiguous and is never
 * silently repaired or treated as absence. All ancestors must be root-owned. */
export async function createProtected(path: string, value: unknown) {
    const bytes = Buffer.from(canonicalJson(value)), parent = await openHostDirectory(dirname(path));
    let file;
    try {
        try { file = await open(`/proc/self/fd/${parent.fd}/${basename(path)}`,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readHostFile(path, 16384)).equals(bytes)) throw new Error('mount_record_conflict');
            return false;
        }
        await file.writeFile(bytes); await file.sync(); await parent.sync(); return true;
    } finally { await file?.close(); await parent.close(); }
}
export async function replaceProtected(path: string, value: unknown) {
    const parent = await openHostDirectory(dirname(path));
    const temporary = `/proc/self/fd/${parent.fd}/mount-authority-${randomUUID()}.json`;
    let created = false;
    try {
        const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); created = true;
        try { await file.writeFile(canonicalJson(value)); await file.sync(); } finally { await file.close(); }
        await rename(temporary, `/proc/self/fd/${parent.fd}/${basename(path)}`); created = false; await parent.sync();
    } finally { if (created) await unlink(temporary); await parent.close(); }
}
type Flag = 'dispatched' | 'begun' | 'cancelled' | 'failed';
export class MountOperationStore {
    readonly path: string;
    constructor(directory: string, readonly authorizationId: string) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(authorizationId)) throw new Error('mount_record_invalid');
        this.path = `${directory}/${authorizationId}`;
    }
    async initialize() { await ensureHostDirectory(this.path); }
    async records() {
        const bytes = await optionalProtected(`${this.path}/records.json`);
        if (!bytes) return null;
        const r = MountRecordsSchema.parse(JSON.parse(bytes.toString()));
        if (r.authorization.authorizationId !== this.authorizationId) throw new Error('mount_record_conflict');
        return r;
    }
    async saveRecords(r: MountRecords) { await this.initialize(); return createProtected(`${this.path}/records.json`, r); }
    async flag(name: Flag) {
        const bytes = await optionalProtected(`${this.path}/${name}.json`);
        if (bytes && bytes.toString() !== canonicalJson({ schemaVersion: 1, state: name })) throw new Error('mount_record_invalid');
        return !!bytes;
    }
    async mark(name: Flag) { await this.initialize(); return createProtected(`${this.path}/${name}.json`, { schemaVersion: 1, state: name }); }
    async receipt() {
        const bytes = await optionalProtected(`${this.path}/receipt.json`);
        return bytes ? JSON.parse(bytes.toString()) as unknown : null;
    }
    async saveReceipt(receipt: unknown) { return createProtected(`${this.path}/receipt.json`, receipt); }
}
export function mountedReceipt(r: MountRecords) {
    const a = r.authorization;
    return { schemaVersion: 1, authorizationId: a.authorizationId, scope: a.scope, digest: a.digest,
        state: 'mounted', computerId: a.scope.computerId, volumeId: a.scope.dataVolumeId, filesystemUuid: a.filesystemUuid };
}
