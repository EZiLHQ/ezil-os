import { describe, expect, it } from 'vitest';
import { runtimeRecords } from '../../../tests/fixtures/runtime-release';
import { compilePreparedInstallation, compileRuntimePlan, RuntimePlanError, sameRuntimePlan } from './runtime-plan';

const PROJECT = 'e5555555-5555-4555-8555-555555555555';
const connectedReticle = () => ({ ...runtimeRecords('reticle'), projectId: PROJECT,
    grants: [{ folder: 'Projects', scope: 'selected-projects', access: 'read-write', projectId: PROJECT }] });

describe('compiled installation preparation', () => {
    it.each(['node', 'reticle'] as const)('prepares %s bytes and private directories without granting execution', kind => {
        const records = runtimeRecords(kind);
        const before = structuredClone(records);
        const prepared = compilePreparedInstallation(records);
        expect(prepared).toEqual({ installationId: records.installationId, releaseId: records.release.id,
            policyDigest: records.release.policyDigest, image: records.release.imageReference,
            privateDirectories: [{ name: 'state', containerPath: '/data/state' }] });
        expect(records).toEqual(before);
        expect(() => compileRuntimePlan(runtimeRecords('reticle'))).toThrow('project_selection_required');
    });
    it('matches the exact release files in a later authorized Reticle execution plan', () => {
        const records = connectedReticle();
        const plan = compileRuntimePlan(records);
        expect(compilePreparedInstallation(records)).toEqual({ installationId: records.installationId,
            releaseId: plan.releaseId, policyDigest: plan.policyDigest, image: plan.image,
            privateDirectories: plan.privateDirectories });
    });
    it('rejects host-incompatible requirements during preparation as well as launch', () => {
        for (const records of [
            runtimeRecords('node', {}, manifest => { manifest.services.push({ ...manifest.services[0]!, name: 'api' }); }),
            runtimeRecords('node', {}, manifest => { manifest.configuration.push({ name: 'THEME', kind: 'text', required: false }); }),
            runtimeRecords('node', {}, manifest => { manifest.egressOrigins = ['https://api.example.com']; }),
            runtimeRecords('node', {}, manifest => { manifest.resources.ephemeralDiskMiB = 8192; }),
        ]) {
            expect(() => compilePreparedInstallation(records)).toThrow(RuntimePlanError);
            expect(() => compileRuntimePlan(records)).toThrow(RuntimePlanError);
        }
    });
    it('rejects mismatched immutable evidence and malformed identity without echoing input', () => {
        for (const field of ['manifestDigest', 'policyDigest', 'imageReference', 'provenanceDigest', 'sourceCommitSha'] as const) {
            const records = runtimeRecords();
            records.release[field] = 'sensitive-sentinel';
            expect(() => compilePreparedInstallation(records)).toThrow('release_evidence_mismatch');
        }
        expect(() => compilePreparedInstallation({ ...runtimeRecords(), installationId: 'sensitive-sentinel' }))
            .toThrow('invalid_installation_identity');
    });
});

describe('compiled supervisor execution plan', () => {
    it('preserves internal ports, uses the stored lease and derives its installation origin', () => {
        const records = runtimeRecords();
        records.leases[0]!.hostPort = 20001;
        const plan = compileRuntimePlan(records);
        expect(plan.services[0]).toMatchObject({ internalPort: 8080, hostPort: 20001, process: { kind: 'node' } });
        expect(plan.allowedOrigins).toEqual(['https://cloud.ezil.org', `https://i-${records.installationId}.apps.ezil.org`]);
        expect(plan.privateDirectories).toEqual([{ name: 'state', containerPath: '/data/state' }]);
    });
    it('requires an explicit selected project and active matching grant for Reticle', () => {
        expect(() => compileRuntimePlan(runtimeRecords('reticle'))).toThrow('project_selection_required');
        expect(() => compileRuntimePlan({ ...runtimeRecords('reticle'), projectId: PROJECT })).toThrow('project_not_connected');
        const plan = compileRuntimePlan(connectedReticle());
        expect(plan.services[0]!.process).toEqual({ kind: 'reticle-daemon-v1', projectId: PROJECT, privateDirectory: 'state' });
        expect(plan.projectGrants).toEqual([{ projectId: PROJECT, access: 'read-write', containerPath: '/workspace/project' }]);
    });
    it('never treats another project or a read grant as Reticle write consent', () => {
        const records = connectedReticle();
        records.projectId = 'f6666666-6666-4666-8666-666666666666';
        expect(() => compileRuntimePlan(records)).toThrow('project_not_connected');
        records.projectId = PROJECT;
        records.grants[0]!.access = 'read';
        expect(() => compileRuntimePlan(records)).toThrow('invalid_reticle_binding');
    });
    it.each(['manifestDigest', 'policyDigest', 'provenanceDigest', 'sourceCommitSha'] as const)('rejects inconsistent %s', field => {
        const records = runtimeRecords();
        records.release[field] = 'untrusted-value';
        expect(() => compileRuntimePlan(records)).toThrow('release_evidence_mismatch');
    });
    it.each([3000, 8181, 9222, 0, 65536, 4400.5])('rejects reserved or invalid leased port %s', port => {
        const records = runtimeRecords();
        records.leases[0]!.hostPort = port;
        expect(() => compileRuntimePlan(records)).toThrow('service_lease_mismatch');
    });
    it('rejects missing/mismatched service records rather than inventing a port', () => {
        const records = runtimeRecords();
        records.services[0]!.internalPort = 4400;
        expect(() => compileRuntimePlan(records)).toThrow('service_lease_mismatch');
        records.leases = [];
        expect(() => compileRuntimePlan(records)).toThrow('service_lease_mismatch');
    });
    it('reports unsupported companion services, configuration and outbound requirements', () => {
        expect(() => compileRuntimePlan(runtimeRecords('node', {}, manifest => {
            manifest.services.push({ ...manifest.services[0]!, name: 'api' });
        }))).toThrow('unsupported_service_layout');
        expect(() => compileRuntimePlan(runtimeRecords('node', {}, manifest => {
            manifest.configuration.push({ name: 'THEME', kind: 'text', required: false });
        }))).toThrow('runtime_configuration_unsupported');
        expect(() => compileRuntimePlan(runtimeRecords('node', {}, manifest => {
            manifest.egressOrigins = ['https://api.example.com'];
        }))).toThrow('runtime_egress_unsupported');
    });
    it('bounds temporary storage and rejects unsupported whole-folder access', () => {
        expect(() => compileRuntimePlan(runtimeRecords('node', {}, manifest => { manifest.resources.ephemeralDiskMiB = 8192; })))
            .toThrow('unsupported_temporary_storage');
        expect(() => compileRuntimePlan(runtimeRecords('node', {}, manifest => {
            manifest.capabilities = ['projects.read'];
            if (manifest.persistence.mode === 'computer-volume') manifest.persistence.sharedFolders = [{
                folder: 'Projects', access: 'read', scope: 'whole-folder', containerPath: '/workspace/projects',
            }];
        }))).toThrow('unsupported_shared_folder');
    });
    it('does not echo input values in failure messages', () => {
        const records = runtimeRecords();
        records.release.manifest = { credentials: 'never-echo-this' };
        try { compileRuntimePlan(records); throw new Error('expected refusal'); }
        catch (error) {
            expect(error).toBeInstanceOf(RuntimePlanError);
            expect(String(error)).toBe('Error: release_contract_invalid');
        }
    });
    it('compares intent independently from JSON object key order', () => {
        const plan = compileRuntimePlan(runtimeRecords());
        expect(sameRuntimePlan(plan, Object.fromEntries(Object.entries(plan).reverse()))).toBe(true);
        expect(sameRuntimePlan(plan, { ...plan, projectGrants: [{ projectId: PROJECT }] })).toBe(false);
    });
});
