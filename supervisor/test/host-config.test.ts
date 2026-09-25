import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { hostAuthority, hostIdentity, parseHostConfig } from '../src/host-config.js';
import { command } from './control-fixture.js';

function config() {
    const cmd = command();
    return { schemaVersion: 1, computerId: cmd.computerId, computerGeneration: 1, volumeId: 'vol-0123456789abcdef0',
        dataRoot: '/srv/ezil-data', stateDirectory: '/var/lib/ezil-supervisor', stagingRoot: '/run/ezil-supervisor/mounts',
        controlPort: 8181, memoryBudgetMiB: 3072, suspended: false,
        approvedInstallations: [{ installationId: cmd.installationId, plan: cmd.plan }] };
}

test('production requires exact ECR digests/HTTPS while private validation retains all authorization', () => {
    const input = config();
    assert.throws(() => parseHostConfig(input), /production_image_or_origin_required/);
    assert.doesNotThrow(() => parseHostConfig(input, true));
    input.approvedInstallations[0]!.plan.image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/app@sha256:${'a'.repeat(64)}`;
    assert.doesNotThrow(() => parseHostConfig(input));
    input.approvedInstallations[0]!.plan.allowedOrigins = ['http://127.0.0.1:4000'];
    assert.throws(() => parseHostConfig(input), /production_image_or_origin_required/);
    input.approvedInstallations[0]!.plan.image = 'node:latest';
    assert.throws(() => parseHostConfig(input, true), /host_configuration_invalid/);
});

test('host approval binds the installation and every execution-plan field', () => {
    const input = parseHostConfig(config(), true);
    const { installationId, plan } = input.approvedInstallations[0]!;
    const approves = hostAuthority(input);
    assert(approves(plan, installationId));
    assert(!approves(plan, randomUUID()));
    const altered = structuredClone(plan);
    altered.projectGrants[0]!.projectId = randomUUID();
    assert(!approves(altered, installationId));
    assert(!approves({ ...plan, allowedOrigins: ['https://unapproved.example'] }, installationId));
    assert(!hostAuthority({ ...input, suspended: true })(plan, installationId));
    assert.equal(hostIdentity(input), hostIdentity({ ...input, suspended: true, approvedInstallations: [] }));
    assert.notEqual(hostIdentity(input), hostIdentity({ ...input, computerGeneration: 2 }));
});

test('configuration rejects scope overlap, control port collisions and unknown data without echoing values', () => {
    const input = config();
    for (const bad of [{ ...input, schemaVersion: 2 }, { ...input, secret: 'sensitive-sentinel' },
        { ...input, stateDirectory: '/srv/ezil-data/private' }, { ...input, stagingRoot: input.stateDirectory },
        { ...input, dataRoot: '/' }, { ...input, controlPort: 4400 },
        { ...input, approvedInstallations: [...input.approvedInstallations, ...input.approvedInstallations] }]) {
        assert.throws(() => parseHostConfig(bad, true), error => error instanceof Error
            && error.message === 'host_configuration_invalid' && !error.message.includes('sensitive-sentinel'));
    }
});
