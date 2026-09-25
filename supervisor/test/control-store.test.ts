import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ControlStore } from '../src/control-store.js';
import { signControlRequest, verifyControlRequest } from '../src/control-auth.js';
import { command, computerId, installationId } from './control-fixture.js';

test('signature replay remains rejected after the process ledger is reopened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezil-control-'));
    let store = new ControlStore(dir, computerId, 1);
    try {
        const secret = Buffer.alloc(32, 33), timestamp = 1_790_000_000;
        const body = Buffer.from(JSON.stringify(command()));
        const request = { method: 'POST', path: '/v1/control', body,
            headers: signControlRequest('POST', '/v1/control', body, secret, timestamp, 'test-nonce-0123456789') };
        assert.deepEqual(verifyControlRequest(request, secret, store, timestamp * 1000), { ok: true });
        store.close(); store = new ControlStore(dir, computerId, 1);
        assert.deepEqual(verifyControlRequest(request, secret, store, timestamp * 1000 + 500),
            { ok: false, code: 'replayed_request' });
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('fences stale intent and delayed observations, persists desired state, and rejects request ID reuse', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezil-control-'));
    let store = new ControlStore(dir, computerId, 1);
    try {
        const first = command();
        assert.equal(store.accept(first), 'accepted');
        assert.equal(store.accept({ ...first, requestId: randomUUID() }), 'reused');
        const stop = { ...first, desired: 'stopped' as const, generation: 2, requestId: randomUUID() };
        assert.equal(store.accept(stop), 'accepted');
        assert.throws(() => store.accept({ ...first, requestId: randomUUID() }), /stale_generation/);
        assert.throws(() => store.accept({ ...stop, desired: 'running', requestId: randomUUID() }), /generation_conflict/);
        assert.throws(() => store.accept({ ...stop, generation: 3 }), /request_id_conflict/);
        assert.throws(() => store.accept({ ...stop, computerGeneration: 2 }), /control_identity_mismatch/);
        assert.equal(store.observe(installationId, 1, 'running'), false);
        assert.equal(store.observe(installationId, 2, 'stopped'), true);
        store.close(); store = new ControlStore(dir, computerId, 1);
        assert.equal(store.get(installationId)?.desired, 'stopped');
        assert.equal(store.get(installationId)?.observed, 'stopped');
        assert.throws(() => new ControlStore(dir, computerId, 2), /control_identity_mismatch/);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('two actual processes racing one generation cannot commit different commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezil-control-'));
    new ControlStore(dir, computerId, 1).close();
    try {
        const source = new URL('../src/control-store.ts', import.meta.url).href;
        const script = `import {ControlStore} from ${JSON.stringify(source)};
            const c=JSON.parse(process.argv[2]);const s=new ControlStore(process.argv[1],c.computerId,c.computerGeneration);
            try{console.log(s.accept(c))}catch(e){console.log(e.message)}finally{s.close()}`;
        const a = command(), b = { ...command(), desired: 'stopped', requestId: randomUUID() };
        const results = await Promise.all([a, b].map(value => promisify(execFile)(process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', script, dir, JSON.stringify(value)], { timeout: 15_000 })));
        assert.deepEqual(results.map(result => result.stdout.trim()).sort(), ['accepted', 'generation_conflict']);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('refuses a symlinked host ledger instead of following it into other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezil-control-'));
    try {
        await symlink(join(dir, 'outside'), join(dir, 'control.sqlite'));
        assert.throws(() => new ControlStore(dir, computerId, 1), /invalid_control_database/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('runtime deadlines persist beyond process/container loss and cannot be extended by a retry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezil-deadline-'));
    let store = new ControlStore(dir, computerId, 1);
    try {
        const first = command();
        const expires = Date.now() + 5000;
        assert.throws(() => store.reserveRuntimeDeadline(first, expires), /runtime_deadline_scope_mismatch/);
        store.accept(first);
        assert.equal(store.runtimeDeadline(first), null);
        assert.equal(store.reserveRuntimeDeadline(first, expires), expires);
        assert.equal(store.reserveRuntimeDeadline(first, expires + 1000), expires);
        store.close(); store = new ControlStore(dir, computerId, 1);
        assert.equal(store.runtimeDeadline(first), expires);
        assert.throws(() => store.runtimeDeadline({ ...first, computerGeneration: 2 }), /control_identity_mismatch/);
        assert.throws(() => store.runtimeDeadline({ ...first, desired: 'stopped' }), /runtime_deadline_scope_mismatch/);
        assert.equal(store.reserveRuntimeDeadline(first, expires + 2000), expires);
        assert.equal(store.reserveRuntimeDeadline(first, expires - 100), expires - 100);
        const next = { ...first, requestId: randomUUID(), generation: 2 };
        store.accept(next);
        assert.throws(() => store.reserveRuntimeDeadline(first, expires), /runtime_deadline_scope_mismatch/);
        assert.equal(store.reserveRuntimeDeadline(next, expires + 3000), expires + 3000);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('approval revisions cannot regress or change content across process restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ezil-approval-'));
    let store = new ControlStore(dir, computerId, 1);
    try {
        store.acceptConfiguration(1, 'a'.repeat(64));
        store.acceptConfiguration(1, 'a'.repeat(64));
        assert.throws(() => store.acceptConfiguration(1, 'b'.repeat(64)), /configuration_revision_conflict/);
        store.acceptConfiguration(3, 'b'.repeat(64));
        store.close(); store = new ControlStore(dir, computerId, 1);
        assert.throws(() => store.acceptConfiguration(2, 'a'.repeat(64)), /configuration_revision_conflict/);
        assert.throws(() => store.acceptConfiguration(3, 'a'.repeat(64)), /configuration_revision_conflict/);
        store.acceptConfiguration(3, 'b'.repeat(64));
        store.acceptConfiguration(4, 'a'.repeat(64));
        assert.throws(() => store.acceptConfiguration(0, 'a'.repeat(64)), /configuration_revision_invalid/);
    } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
