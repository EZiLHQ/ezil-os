import assert from 'node:assert/strict';
import test from 'node:test';
import { ControlCommandSchema, ExecutionPlanSchema } from '../src/control-protocol.js';

import { command } from './control-fixture.js';

test('accepts a scoped immutable execution plan and rejects publisher/control authority fields', () => {
    const valid = command();
    assert.deepEqual(ControlCommandSchema.parse(valid), valid);
    for (const changed of [
        { ...valid, ec2Id: 'i-caller-selected' },
        { ...valid, plan: { ...valid.plan, environment: { AWS_SECRET_ACCESS_KEY: 'private' } } },
        { ...valid, plan: { ...valid.plan, image: 'registry.example/app:latest' } },
        { ...valid, plan: { ...valid.plan, image: 'user:secret@registry.example/app@sha256:' + 'a'.repeat(64) } },
        { ...valid, plan: { ...valid.plan, privateDirectories: [{ name: 'state', containerPath: '/data/../etc' }] } },
    ]) assert.equal(ControlCommandSchema.safeParse(changed).success, false);
});
test('Reticle requires an explicit writable project, its private state mount and actual service port', () => {
    const plan = command().plan;
    for (const changed of [
        { ...plan, projectGrants: [] },
        { ...plan, projectGrants: [{ ...plan.projectGrants[0], access: 'read' }] },
        { ...plan, privateDirectories: [] },
        { ...plan, services: [{ ...plan.services[0], internalPort: 4401 }] },
        { ...plan, services: [{ ...plan.services[0], hostPort: 8443 }] },
    ]) assert.equal(ExecutionPlanSchema.safeParse(changed).success, false);
});
test('rejects overlapping mounts, port collisions and cyclic or missing service dependencies', () => {
    const plan = command().plan;
    for (const changed of [
        { ...plan, privateDirectories: [...plan.privateDirectories, { name: 'nested', containerPath: '/data/reticle/private' }] },
        { ...plan, services: [...plan.services, { ...plan.services[0], name: 'other' }] },
        { ...plan, services: [{ ...plan.services[0], dependsOn: ['absent'] }] },
        { ...plan, services: [{ ...plan.services[0], dependsOn: ['daemon'] }] },
    ]) assert.equal(ExecutionPlanSchema.safeParse(changed).success, false);
});
