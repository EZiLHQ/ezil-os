import { z } from 'zod';
import { canonicalJson } from './control-protocol.js';
import { ProvisioningSchema, validateDelivery, descriptor } from './configuration-delivery-contract.js';
import { ControlBootstrapAuthorizationSchema, validateControlBootstrap } from './control-bootstrap-contract.js';
import { optionalProtected, createProtected, ensureDurableDirectory } from './mount-operation-store.js';

export const StartRecordsSchema = z.object({ provisioning: ProvisioningSchema,
    authorization: ControlBootstrapAuthorizationSchema }).strict().refine(r => {
    try {
        validateControlBootstrap({ schemaVersion: 1, authorizationId: r.authorization.authorizationId },
            r.provisioning, r.authorization, r.authorization.issuedAt * 1000);
        validateDelivery(r.authorization.configuration, r.provisioning); return true;
    } catch { return false; }
}, 'start_records_invalid');
export type StartRecords = z.infer<typeof StartRecordsSchema>;
export const START_STATE = '/var/lib/ezil-start-deliveries';
type Flag = 'dispatched' | 'begun' | 'cancelled' | 'failed';
/** Root-owned, fsynced and never erased to retry a lost operation. */
export class StartOperationStore {
    readonly path: string;
    constructor(readonly authorizationId: string) {
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(authorizationId)) throw new Error('start_record_invalid');
        this.path = `${START_STATE}/${authorizationId}`;
    }
    async initialize() { await ensureDurableDirectory(START_STATE); await ensureDurableDirectory(this.path); }
    async records() {
        const bytes = await optionalProtected(`${this.path}/records.json`); if (!bytes) return null;
        const r = StartRecordsSchema.parse(JSON.parse(bytes.toString()));
        if (r.authorization.authorizationId !== this.authorizationId) throw new Error('start_record_invalid'); return r;
    }
    async saveRecords(r: StartRecords) { await this.initialize(); return createProtected(`${this.path}/records.json`, r); }
    async flag(name: Flag) {
        const bytes = await optionalProtected(`${this.path}/${name}.json`);
        if (bytes && bytes.toString() !== canonicalJson({ schemaVersion: 1, state: name })) throw new Error('start_record_invalid');
        return !!bytes;
    }
    async mark(name: Flag) { await this.initialize(); return createProtected(`${this.path}/${name}.json`, { schemaVersion: 1, state: name }); }
    async receipt() { const bytes = await optionalProtected(`${this.path}/receipt.json`); return bytes ? JSON.parse(bytes.toString()) as unknown : null; }
    async saveReceipt(value: unknown) { return createProtected(`${this.path}/receipt.json`, value); }
}
export function startedReceipt(r: StartRecords) {
    return { schemaVersion: 1, authorizationId: r.authorization.authorizationId, scope: r.provisioning.scope,
        state: 'started', descriptor: descriptor(r.authorization.configuration) };
}
