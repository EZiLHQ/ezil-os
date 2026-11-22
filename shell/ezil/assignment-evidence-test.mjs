import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import {
    isAssignmentEvidenceActive,
    mountAssignmentEvidence,
    recordAssignmentEvent,
    recordAssignmentWindow,
    subscribeAssignmentEvidence,
} from './assignment-evidence.js';

const scope = { computerId: 'assignment-computer', repositoryUrl: 'https://github.ezil.work/default/assignment.git' };
const hour = 60 * 60 * 1_000;
const now = () => new Date('2026-11-21T19:00:00.000Z');
const active = {
    id: '00000000-0000-4000-8000-000000000001',
    state: 'active',
    startedAt: now().toISOString(),
    expiresAt: new Date(now().getTime() + hour).toISOString(),
};
class Element extends EventTarget {
    children = [];
    attributes = new Map();
    constructor(ownerDocument) { super(); this.ownerDocument = ownerDocument; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name); }
    append(...children) { this.children.push(...children); }
    remove() {}
    click() { this.dispatchEvent(new Event('click')); }
}
class TestDocument extends EventTarget {
    visibilityState = 'visible';
    createElement() { return new Element(this); }
}
function fixture() {
    const document = new TestDocument();
    const container = document.createElement();
    const owner = document.createElement();
    owner.setAttribute('data-app', 'code');
    owner.setAttribute('data-ezil-computer-id', scope.computerId);
    return { container, owner };
}

test('explicit start scopes Code and drains retained events before explicit end', async () => {
    const { container, owner } = fixture();
    const actions = [];
    let appends = 0;
    const request = async action => {
        actions.push(action);
        if ( !action ) return { enabled: true, assignment: scope, attempt: null };
        if ( action.action === 'start' ) return { attempt: active };
        if ( action.action === 'append' ) {
            assert.equal(action.attemptId, active.id);
            appends++;
            if ( appends === 1 ) throw new Error('temporary disconnect');
            return { accepted: action.events.map(event => event.id) };
        }
        return { attempt: { ...active, state: 'ended' } };
    };
    const controller = mountAssignmentEvidence({ container, owner, ...scope }, { request, now });
    const notifications = [];
    const unsubscribe = subscribeAssignmentEvidence(scope, value => notifications.push(value));
    try {
        await setImmediate();
        const [, start, stop] = container.children[0].children;
        assert.equal(isAssignmentEvidenceActive(scope), false);
        assert.equal(recordAssignmentEvent('code.file_opened', { path: 'main.py' }, scope), false);
        start.click();
        await setImmediate();
        assert.equal(isAssignmentEvidenceActive(scope), true);
        assert.equal(recordAssignmentEvent('code.file_opened', { path: 'main.py', secret: 'excluded' }, scope), true);
        assert.equal(recordAssignmentEvent('code.file_opened', { path: '.env' }, scope), false);
        assert.equal(recordAssignmentEvent('code.file_opened', { path: 'credentials.json' }, scope), false);
        const model = { requestId: active.id, model: 'claude-sonnet-4.6', outcome: 'completed' };
        assert.equal(recordAssignmentEvent('model.completed', model), false);
        assert.equal(recordAssignmentEvent('model.completed', { ...model, model: 'my-api-key' }, scope), false);
        assert.equal(recordAssignmentEvent('model.completed', { ...model, prompt: 'excluded' }, scope), true);
        recordAssignmentWindow('app.focused', owner);
        const unrelated = new Element(owner.ownerDocument);
        unrelated.setAttribute('data-app', 'desktop');
        unrelated.setAttribute('data-ezil-computer-id', scope.computerId);
        recordAssignmentWindow('app.focused', unrelated);
        stop.click();
        await setImmediate();
        assert.equal(isAssignmentEvidenceActive(scope), false);
        assert.deepEqual(actions.map(action => action?.action ?? 'read'), ['read', 'start', 'append']);
        stop.click();
        await setImmediate();
        assert.deepEqual(actions.map(action => action?.action ?? 'read'), ['read', 'start', 'append', 'append', 'end']);
        assert.deepEqual(actions[2].events, actions[3].events);
        assert.deepEqual(actions[3].events.map(({ kind, detail }) => ({ kind, detail })), [
            { kind: 'activity.visibility', detail: { state: 'foreground' } },
            { kind: 'code.file_opened', detail: { path: 'main.py' } },
            { kind: 'model.completed', detail: model },
            { kind: 'app.focused', detail: { app: 'code' } },
        ]);
        assert.deepEqual(notifications, [false, true, false]);
    } finally {
        unsubscribe();
        controller.dispose();
    }
});

test('reload stays paused and a confirmed expired attempt cannot resume capture', async () => {
    const { container, owner } = fixture();
    const actions = [];
    const request = async action => {
        actions.push(action);
        return { enabled: true, assignment: scope, attempt: actions.length === 1 ? active : { ...active, state: 'expired' } };
    };
    const controller = mountAssignmentEvidence({ container, owner, ...scope }, { request, now });
    try {
        await setImmediate();
        const [, resume] = container.children[0].children;
        assert.equal(resume.textContent, 'Resume assignment evidence');
        assert.equal(isAssignmentEvidenceActive(scope), false);
        resume.click();
        await setImmediate();
        assert.equal(isAssignmentEvidenceActive(scope), false);
        assert.deepEqual(actions, [undefined, undefined]);
        assert.equal(resume.textContent, 'Start assignment evidence');
    } finally {
        controller.dispose();
    }
});
