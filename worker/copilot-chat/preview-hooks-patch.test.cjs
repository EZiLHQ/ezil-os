// COPILOT_TEST_ROOT is read-only. Every mutation below is on a disposable copy.
// App preview hooks (`chat-hooks`, `chat-pane`): docs/contracts/code-preview-v1.md, PATCHES.md "App preview hooks".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const vectors = require('../../docs/contracts/code-preview-v1.vectors.json');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json',
    'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb,
    'out/vs/code/browser/workbench/workbench.css', 'out/server-main.js'];
const HOOKS = '},pe=new YLi;var XLi=class s{';
const PANE = 'get widget(){return this._widget}createChatControl(e){let t=E(e,';
const count = (s, needle) => s.split(needle).length - 1;
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
// Vectors write long strings as "@repeat:<char>:<n>".
const expand = v => typeof v === 'string' && v.startsWith('@repeat:') ? v.split(':')[1].repeat(Number(v.split(':')[2]))
    : Array.isArray(v) ? v.map(expand) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)])) : v;

/** The inserted module-level code, run with a fake CommandsRegistry, window and timers. */
function load(code) {
    const start = code.indexOf('},pe=new YLi;') + '},pe=new YLi;'.length;
    const end = code.indexOf('var XLi=class s{', start);
    assert.ok(start > 20 && end > start);
    const handlers = new Map(), listeners = new Map(), dispatched = [], timers = new Map();
    let takes = false, nextTimer = 1;
    const window = {
        addEventListener: (type, fn) => listeners.set(type, fn),
        dispatchEvent: event => { dispatched.push(event); if (takes && event.cancelable) event.defaultPrevented = true; return !event.defaultPrevented; },
    };
    const sandbox = {
        qe: { registerCommand: (id, handler) => handlers.set(id, handler) }, window,
        CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o.detail; this.cancelable = o.cancelable === true; this.defaultPrevented = false; } },
        setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
        clearTimeout: id => timers.delete(id),
        URL, JSON, Promise, Reflect, Object, Array, Set, Map, WeakSet, Number, String,
    };
    runInNewContext(`${code.slice(start, end)};this.ezilBindChatPane=ezilBindChatPane;`, sandbox);
    return { handlers, listeners, dispatched, timers, sandbox, take: v => { takes = v; } };
}

/** A ChatViewPane-shaped fake whose widget follows the pinned 1.141 attachment model (addContext skips known ids,
 * updateContext replaces in place) and switches sessions like setViewModel + input-state restore. */
function pane(visible = true, session = 'vscode-chat-session://local/A') {
    const attachments = new Map(), log = [], disposables = [], onModel = [], onChange = [];
    const resource = s => ({ toString: () => s });
    const model = {
        get attachments() { return [...attachments.values()]; },
        addContext: (...entries) => {
            const added = entries.filter(e => !attachments.has(e.id));
            for (const e of added) { attachments.set(e.id, e); log.push(['add', e.id]); }
            if (added.length) onChange.forEach(f => f({ added, deleted: [], updated: [] }));
        },
        delete: (...ids) => { for (const id of ids) { attachments.delete(id); log.push(['delete', id]); } },
        updateContext: (deleted, entries) => {
            for (const id of deleted) attachments.delete(id);
            for (const e of entries) { log.push([attachments.has(e.id) ? 'update' : 'add', e.id]); attachments.set(e.id, e); }
        },
        onDidChange: f => { onChange.push(f); return { dispose() {} }; },
    };
    const widget = { attachmentModel: model, viewModel: { sessionResource: resource(session) }, input: { value: 'unsent draft' },
        refreshed: 0, refreshParsedInput() { this.refreshed++; },
        onDidChangeViewModel: f => { onModel.push(f); return { dispose() {} }; },
        focusInput() { throw new Error('focus must not move'); }, acceptInput() { throw new Error('must not send'); } };
    // Restore order differs between a cached and a loaded session: cover both.
    const switchTo = (s, restored = [], restoreFirst = false) => {
        attachments.clear();
        const restore = () => restored.length && model.addContext(...restored.map(e => ({ ...e })));
        if (restoreFirst) { widget.viewModel = { sessionResource: resource(s) }; restore(); onModel.forEach(f => f({})); }
        else { widget.viewModel = { sessionResource: resource(s) }; onModel.forEach(f => f({})); restore(); }
    };
    return { _widget: widget, isBodyVisible: () => visible, _register: d => disposables.push(d), attachments, log, disposables, widget, switchTo };
}

test('preview hooks: pinned anchors, apply, verify, idempotence and the actual patched functions',
    { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-preview-hooks-patch-'));
    try {
        for (const file of files) {
            const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(source, file), dest);
        }
        const pristine = fs.readFileSync(path.join(root, wb), 'utf8');
        assert.equal(count(pristine, HOOKS), 1); assert.equal(count(pristine, PANE), 1);
        for (const args of [[root], ['--verify', root]]) {
            const result = run(...args); assert.equal(result.status, 0, result.stdout + result.stderr);
            for (const line of ['gate ok [chat-hooks] workbench.js x0', 'gate ok [chat-hooks] workbench.js x1',
                'gate ok [chat-hooks-command] workbench.js x1', 'gate ok [chat-pane] workbench.js x0', 'gate ok [chat-pane] workbench.js x1']) {
                assert.ok(result.stdout.includes(line), line);
            }
        }
        const before = files.map(file => fs.readFileSync(path.join(root, file)));
        const again = run(root); assert.equal(again.status, 0, again.stdout + again.stderr);
        files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[i], file));
        const code = fs.readFileSync(path.join(root, wb), 'utf8');
        assert.equal(count(code, HOOKS), 0); assert.equal(count(code, PANE), 0);
        // The pane registers itself before its widget is created, and the app-failure tail stays byte-identical.
        assert.equal(count(code, 'createChatControl(e){ezilBindChatPane(this);let t=E(e,'), 1);
        assert.equal(count(code, 'qe.registerCommand("_ezil.appFailure",(accessor,record)=>{ezilDispatchAppFailure(record)});var YLi='), 1);
        for (const id of ['_ezil.chatAddContext', '_ezil.previewMint', '_ezil.previewMintCancel']) assert.equal(count(code, `qe.registerCommand("${id}",`), 1, id);

        await t.test('only three fixed commands are registered; no command id comes from a caller', () => {
            const { handlers } = load(code);
            assert.deepEqual([...handlers.keys()], ['_ezil.chatAddContext', '_ezil.previewMint', '_ezil.previewMintCancel']);
            assert.equal(count(code.slice(code.indexOf('var ezilChatPanes='), code.indexOf('var XLi=class s{')), 'executeCommand'), 0);
        });

        await t.test('chatAddContext: contract vectors, no target, draft and focus untouched, duplicate and stale replacement', () => {
            const { handlers, sandbox } = load(code);
            const add = r => handlers.get('_ezil.chatAddContext')({}, r);
            const [fresh, stale] = vectors.attachment.accept;
            assert.equal(add(fresh), false, 'no chat pane yet: refused, never attached elsewhere');
            const p = pane(); sandbox.ezilBindChatPane(p);
            for (const bad of vectors.attachment.refuse.map(expand)) assert.equal(add(bad), false, JSON.stringify(bad).slice(0, 80));
            assert.equal(add(Object.assign(Object.create({ stale: false }), { v: 1, id: fresh.id, name: 'x', value: 'x' })), false, 'inherited key');
            assert.equal(add(stale), false, 'stale for an attachment the user never had or removed');
            assert.equal(add(fresh), true);
            const entry = p.attachments.get(fresh.id);
            assert.equal(entry.kind, 'generic'); assert.equal(entry.name, fresh.name); assert.equal(entry.value, fresh.value);
            assert.match(entry.modelDescription, /not a source location/);
            assert.equal(p.widget.input.value, 'unsent draft'); assert.equal(p.widget.refreshed, 1);
            assert.equal(add(fresh), true); assert.equal(p.log.length, 1, 'same id twice adds once');
            assert.equal(add(stale), true);
            assert.deepEqual(p.log, [['add', fresh.id], ['update', fresh.id]], 'replaced in place, not re-added');
            assert.equal(p.attachments.get(fresh.id).name, `${fresh.name} (stale)`);
            assert.match(p.attachments.get(fresh.id).value, /^STALE: /);
            assert.equal(p.widget.input.value, 'unsent draft');
        });

        await t.test('stale marks the owner session only: A -> B -> stale -> A, both restore orders, removed chips stay gone', () => {
            for (const restoreFirst of [false, true]) {
                const { handlers, sandbox } = load(code);
                const add = r => handlers.get('_ezil.chatAddContext')({}, r);
                const p = pane(); sandbox.ezilBindChatPane(p);
                const one = { ...vectors.attachment.accept[0], id: 'ezil-preview:AAAAAAAAAAAAAAAAAAAAAA' };
                const two = { ...one, id: 'ezil-preview:BBBBBBBBBBBBBBBBBBBBBB' };
                assert.equal(add(one), true); assert.equal(add(two), true);
                const kept = p.attachments.get(one.id);
                p.switchTo('vscode-chat-session://local/B');
                assert.equal(add({ ...one, stale: true }), true, 'queued for A while B is shown');
                assert.equal(add({ ...two, stale: true }), true);
                assert.equal(p.attachments.size, 0, 'B never receives A attachments');
                // Back on A; the person had removed `two` before switching away, so only `one` is restored.
                p.switchTo('vscode-chat-session://local/A', [kept], restoreFirst);
                assert.equal(p.attachments.get(one.id).name, `${one.name} (stale)`, `restoreFirst=${restoreFirst}`);
                assert.equal(p.attachments.has(two.id), false, 'no resurrection');
                assert.equal(p.widget.input.value, 'unsent draft');
                // A later visit applies nothing twice.
                const before = p.log.length; p.switchTo('vscode-chat-session://local/A', [p.attachments.get(one.id)], restoreFirst);
                assert.equal(p.log.filter(([op]) => op === 'update').length, 1); assert.ok(p.log.length > before);
            }
        });

        await t.test('the visible pane wins; a disposed pane is never a target', () => {
            const { handlers, sandbox } = load(code);
            const add = r => handlers.get('_ezil.chatAddContext')({}, r);
            const hidden = pane(false), shown = pane(true);
            sandbox.ezilBindChatPane(hidden); sandbox.ezilBindChatPane(shown);
            assert.equal(add(vectors.attachment.accept[0]), true);
            assert.equal(shown.attachments.size, 1); assert.equal(hidden.attachments.size, 0);
            shown.disposables.forEach(d => d.dispose()); hidden.disposables.forEach(d => d.dispose());
            assert.equal(add({ ...vectors.attachment.accept[0], id: 'ezil-preview:BBBBBBBBBBBBBBBBBBBBBB' }), false);
        });

        await t.test('previewMint: no shell, accepted reply, refused replies, cancel, timeout, busy and duplicate', async () => {
            const { handlers, listeners, dispatched, timers, take } = load(code);
            // Results are made in the vm realm; compare them as plain data.
            const mint = async r => JSON.parse(JSON.stringify(await handlers.get('_ezil.previewMint')({}, r)));
            const cancel = r => handlers.get('_ezil.previewMintCancel')({}, r);
            const reply = detail => listeners.get('ezil-preview-mint-reply')({ detail: JSON.stringify(detail) });
            const id = n => String(n).padStart(22, 'A');
            assert.deepEqual(await mint({ v: 1, id: id(1) }), { error: 'no_shell' }, 'nobody took the event');
            assert.equal(timers.size, 0);
            for (const bad of [null, [], { v: 2, id: id(2) }, { v: 1, id: 'short' }, { v: 1, id: id(2), extra: 1 }]) {
                assert.deepEqual(await mint(bad), { error: 'invalid_request' });
            }
            take(true);
            const pending = mint({ v: 1, id: id(3) });
            assert.deepEqual(JSON.parse(dispatched.at(-1).detail), { v: 1, id: id(3) });
            assert.deepEqual(await mint({ v: 1, id: id(3) }), { error: 'duplicate_request' });
            for (const bad of vectors.mintReply.refuse) reply({ v: 1, id: id(3), ...bad });
            reply({ v: 1, id: id(99), ...vectors.mintReply.accept[0] });
            reply({ v: 1, id: id(3), ...vectors.mintReply.accept[0] });
            assert.deepEqual(await pending, vectors.mintReply.accept[0]);
            assert.equal(timers.size, 0, 'answered: its timer is gone');

            const errored = mint({ v: 1, id: id(4) }); reply({ v: 1, id: id(4), ...vectors.mintReply.accept[1] });
            assert.deepEqual(await errored, vectors.mintReply.accept[1]);

            const closed = mint({ v: 1, id: id(5) });
            assert.equal(cancel({ v: 1, id: id(5) }), true); assert.equal(cancel({ v: 1, id: id(5) }), false);
            assert.deepEqual(await closed, { error: 'cancelled' }); assert.equal(timers.size, 0);
            reply({ v: 1, id: id(5), ...vectors.mintReply.accept[0] }); // a late answer for a cancelled id goes nowhere

            const slow = mint({ v: 1, id: id(6) });
            const [[timer, { fn, ms }]] = [...timers]; assert.equal(ms, 240000);
            timers.delete(timer); fn();
            assert.deepEqual(await slow, { error: 'timeout' });
            // Cancel and timeout each tell the OS bridge once, so the shell can abort its mint; an answer does not.
            const abandoned = dispatched.filter(e => e.type === 'ezil-preview-mint-cancel').map(e => JSON.parse(e.detail));
            assert.deepEqual(abandoned, [{ v: 1, id: id(5) }, { v: 1, id: id(6) }]);
            assert.ok(dispatched.filter(e => e.type === 'ezil-preview-mint-cancel').every(e => !e.cancelable));

            const four = [7, 8, 9, 10].map(n => mint({ v: 1, id: id(n) }));
            assert.deepEqual(await mint({ v: 1, id: id(11) }), { error: 'busy' });
            [7, 8, 9, 10].forEach(n => cancel({ v: 1, id: id(n) }));
            assert.deepEqual(await Promise.all(four), four.map(() => ({ error: 'cancelled' })));
            assert.equal(timers.size, 0);
        });

        await t.test('verify rejects a bundle missing either hook', () => {
            for (const [label, from, to] of [['chat-hooks', 'qe.registerCommand("_ezil.previewMintCancel",', 'qe.registerCommand("_ezil.previewMintCancelX",'],
                ['chat-pane', 'createChatControl(e){ezilBindChatPane(this);', 'createChatControl(e){']]) {
                fs.writeFileSync(path.join(root, wb), code.replace(from, to));
                const result = run('--verify', root);
                assert.notEqual(result.status, 0, label);
            }
            fs.writeFileSync(path.join(root, wb), code);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
