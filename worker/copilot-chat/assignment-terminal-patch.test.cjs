const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { apply, verify, createAssignmentTerminalProducer } = require('./patch-assignment-terminal.cjs');

const ROOT = '/workspace/projects/11111111-1111-4111-8111-111111111111/test-repo';
const NONCE = 'A'.repeat(22);
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';

function fixture() {
    const dataset = {};
    const events = [];
    const instance = {};
    const producer = createAssignmentTerminalProducer(
        { documentElement: { dataset } },
        { dispatchEvent: event => events.push(event) },
        { randomUUID: () => EXECUTION_ID },
    );
    function arm() {
        Object.assign(dataset, { ezilAssignmentTerminal: '1', ezilAssignmentRoot: ROOT, ezilAssignmentTerminalNonce: NONCE });
    }
    function execute(start = {}, finish = {}, finishInstance = instance) {
        const marker = {};
        producer.start({ instance, data: { cwd: ROOT, commandExecutedMarker: marker, ...start } });
        producer.finish({ instance: finishInstance, data: {
            cwd: ROOT, executedMarker: marker, command: 'git status --short', isTrusted: true,
            commandLineConfidence: 'high', exitCode: 0, duration: 25, ...finish,
        } });
    }
    return { producer, events, dataset, instance, arm, execute };
}

test('only an armed and completed root-level shell execution emits the allowlisted command', () => {
    const f = fixture();
    f.execute();
    assert.deepEqual(f.events, []);
    f.arm();
    f.execute();
    assert.equal(f.events[0].type, 'ezil:assignment-terminal');
    assert.deepEqual(f.events[0].detail, {
        executionId: EXECUTION_ID,
        command: 'git status --short',
        exitCode: 0,
        durationMs: 25,
    });
});

test('unlisted strings and credential-like arguments produce only lifecycle metadata', () => {
    const f = fixture();
    f.arm();
    for (const command of ['npm test -- --ENV_TOKEN=synthetic-secret', 'AWS_SECRET_ACCESS_KEY=fixture ls',
        'pwd && cat .env', ' npm test', 'ls -l ./notes', { value: 'pwd' }]) {
        f.execute({}, { command, exitCode: 7, duration: 340 });
    }
    assert.equal(f.events.length, 6);
    assert.ok(f.events.every(event => !event.detail.command && event.detail.exitCode === 7));
    assert.doesNotMatch(JSON.stringify(f.events.map(event => event.detail)), /synthetic-secret|TOKEN|\.env|notes/);
    f.execute({}, { command: 'python3 -m pytest', exitCode: undefined, duration: Infinity });
    assert.deepEqual(f.events.at(-1).detail, {
        executionId: EXECUTION_ID, command: 'python3 -m pytest', exitCode: null, durationMs: null,
    });
});

test('out-of-scope shell, replay, unmatched terminal, and weak command trust produce no record', () => {
    const f = fixture();
    f.arm();
    f.execute({ cwd: ROOT + '/subdir' });
    f.execute({}, { cwd: '/workspace/other' });
    f.execute({}, { isTrusted: false });
    f.execute({}, { commandLineConfidence: 'medium' });
    f.execute({}, { wasReplayed: true });
    f.execute({}, {}, {});
    f.producer.finish({ instance: f.instance, data: { executedMarker: {}, cwd: ROOT, command: 'pwd', isTrusted: true, commandLineConfidence: 'high' } });
    assert.deepEqual(f.events, []);
});

test('duplicate finish and commands crossing Stop or a later consent do not emit', () => {
    const f = fixture();
    f.arm();
    const oldMarker = {};
    const start = marker => f.producer.start({ instance: f.instance, data: { commandExecutedMarker: marker, cwd: ROOT } });
    const finish = marker => f.producer.finish({ instance: f.instance, data: {
        executedMarker: marker, cwd: ROOT, command: 'pwd', isTrusted: true, commandLineConfidence: 'high',
    } });
    start(oldMarker);
    delete f.dataset.ezilAssignmentTerminal;
    finish(oldMarker);
    assert.equal(f.events.length, 0);

    f.arm();
    const newMarker = {};
    start(newMarker);
    f.dataset.ezilAssignmentTerminalNonce = 'B'.repeat(22);
    finish(newMarker);
    assert.equal(f.events.length, 0);

    const freshMarker = {};
    start(freshMarker);
    start(freshMarker);
    finish(freshMarker);
    finish(freshMarker);
    assert.equal(f.events.length, 1);
});

const START = 'this._proxy.$shellExecutionStart(f,I6o(g.instance),g.data.command,y6o(g.data),g.data.isTrusted,g.data.cwd)';
const END = 'this._proxy.$shellExecutionEnd(f,g.data.command,y6o(g.data),g.data.isTrusted,g.data.exitCode)';
const HELPER = 'function y6o(s){switch(s.commandLineConfidence){';

test('patch requires all three exact upstream anchors and detects partial changes', () => {
    const bundle = START + ';' + END + ';' + HELPER + '}}';
    const patched = apply(bundle);
    assert.equal(verify(patched), patched);
    assert.equal(apply(patched), patched);
    assert.throws(() => apply(bundle + END), /pinned anchor 2/);
    assert.throws(() => apply(bundle.replace(HELPER, '')), /pinned anchor 3/);
    assert.throws(() => verify(patched.replace('ezilAssignmentTerminalProducer.finish(g),', '')), /replacement 2/);
});

const pinned = process.env.EZIL_TERMINAL_PINNED_WORKBENCH;
test('matches the exact installed code-server Workbench', { skip: !pinned }, () => {
    const source = fs.readFileSync(pinned, 'utf8');
    const patched = apply(source);
    assert.notEqual(source, patched);
    assert.equal(verify(patched), patched);
});
