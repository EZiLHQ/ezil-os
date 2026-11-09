// COPILOT_TEST_ROOT is read-only. Every mutation below is on a disposable copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json',
    'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb,
    'out/vs/code/browser/workbench/workbench.css', 'out/server-main.js'];
const anchors = {
    'billing-intent': 'getCommands(){let s=new Map;for(let o of this._commands.keys()){let e=this.getCommand(o);e&&s.set(o,e)}return s}};',
    'picker-locked-list': 'let D=!1,M=Bhn({models:u,',
    'picker-locked-pin': 'makePinAction:n=>s.actions.onTogglePin?Lhn(n.identifier,s.pinnedModelIds.includes(n.identifier),s.actions.onTogglePin):void 0',
    'picker-locked-configure': ',l=(ee,ae,he)=>{c(ee),this._actionWidgetService.hide(),this._configuration.show(',
    'picker-locked-select': 'c=ee=>{a.logModelChange(this._selectedModel,ee,this._delegate.getChatSessionId?.()),this._selectedModel=ee,this._renderLabel(),this._onDidChangeSelection.fire(ee)}',
};
const count = (s, needle) => s.split(needle).length - 1;
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const REQUEST_ID = 'a3ef61c6-138b-4ea5-9246-c0ce489bfd57';
const LOCK_TEXT = 'Not included in your plan. Choose it to see the upgrade.';
const locked = (id, extra = {}) => ({ id, name: id, vendor: 'ezil', isUserSelectable: false, infoText: { ezilPlanLocked: LOCK_TEXT }, ...extra });

test('plan locks: pinned anchors, apply, verify, idempotence and the actual patched functions',
    { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-plan-lock-patch-'));
    const restore = () => {
        for (const file of files) {
            const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(source, file), dest);
        }
    };
    try {
        restore();
        const pristine = fs.readFileSync(path.join(root, wb), 'utf8');
        for (const [id, anchor] of Object.entries(anchors)) assert.equal(count(pristine, anchor), 1, id);
        for (const args of [[root], ['--verify', root]]) {
            const result = run(...args); assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.ok(result.stdout.includes('gate ok [billing-intent] workbench.js x1'));
            assert.ok(result.stdout.includes('gate ok [billing-intent-command] workbench.js x1'));
            for (const id of ['picker-locked-list', 'picker-locked-pin', 'picker-locked-select', 'picker-locked-configure']) {
                assert.ok(result.stdout.includes(`gate ok [${id}] workbench.js x0`), id);
                assert.ok(result.stdout.includes(`gate ok [${id}] workbench.js x1`), id);
            }
        }
        const before = files.map(file => fs.readFileSync(path.join(root, file)));
        const again = run(root); assert.equal(again.status, 0, again.stdout + again.stderr);
        files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[i], file));
        const code = fs.readFileSync(path.join(root, wb), 'utf8');
        for (const id of ['picker-locked-list', 'picker-locked-pin', 'picker-locked-select', 'picker-locked-configure']) assert.equal(count(code, anchors[id]), 0, id);
        // The tabbed picker and every other reader of the picker's model list are unchanged.
        assert.equal(count(code, 'u=this._delegate.getModels(),p=this._delegate.getPresentationOptions()'), 1);
        assert.equal(count(code, 'this._tabbedPicker.value?.refresh(this._delegate.getModels())'), 1);
        assert.equal(count(code, 'qe.registerCommand("_ezil.billingIntent",'), 1);
        // The app-failure registration right after the insertion is untouched (its re-run detection depends on it).
        assert.equal(count(code, 'qe.registerCommand("noop",()=>{});function ezilDispatchAppFailure(record){'), 1);
        // The inserted helpers sit at module level, before the app-failure registration that follows the class.
        const start = code.indexOf('function ezilDispatchBillingIntent(');
        const end = code.indexOf('qe.registerCommand("_ezil.billingIntent",(accessor,record)=>ezilDispatchBillingIntent(record));', start);
        assert.ok(start > 0 && end > start);
        const registration = code.slice(start, end + 'qe.registerCommand("_ezil.billingIntent",(accessor,record)=>ezilDispatchBillingIntent(record));'.length);
        const handlers = new Map(), events = [];
        let takes = false;
        const window = { dispatchEvent: event => { events.push(event); if (takes && event.cancelable) event.defaultPrevented = true; return !event.defaultPrevented; } };
        const sandbox = {
            qe: { registerCommand: (id, handler) => handlers.set(id, handler) }, window,
            CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; this.cancelable = options.cancelable === true; this.defaultPrevented = false; } },
        };
        runInNewContext(`${registration};this.ezilPlanLocked=ezilPlanLocked;this.ezilPickerModels=ezilPickerModels;`, sandbox);
        const ask = value => handlers.get('_ezil.billingIntent')({}, value);

        await t.test('billing intent: only the known reasons, a request UUID and a model alias; true only when the OS took it', () => {
            assert.deepEqual([...handlers.keys()], ['_ezil.billingIntent']);
            const valid = [{ reason: 'credits_exhausted', requestId: REQUEST_ID }, { reason: 'model_locked', model: 'qwen.qwen3-coder-next' },
                { reason: 'credits_exhausted' }, { reason: 'model_locked', model: 'us.moonshotai.kimi-k3' }];
            for (const record of valid) {
                events.length = 0; takes = false;
                assert.equal(ask(record), false, 'nobody took it: the extension keeps its own notice');
                assert.equal(events.length, 1);
                assert.equal(events[0].type, 'ezil-billing-intent');
                assert.equal(events[0].cancelable, true);
                assert.deepEqual(JSON.parse(events[0].detail), record);
                events.length = 0; takes = true;
                assert.equal(ask(record), true, 'a listener that called preventDefault took it');
                assert.equal(events.length, 1);
            }
            takes = true; events.length = 0;
            let touched = 0;
            const getter = () => { touched++; throw new Error('must not read'); };
            const invalid = [undefined, null, 'model_locked', [], [{ reason: 'model_locked' }], {}, { reason: 'upgrade' }, { reason: 'insufficient_credits' },
                { reason: 'model_locked', model: 'Qwen' }, { reason: 'model_locked', model: '../x' }, { reason: 'model_locked', model: 'x'.repeat(65) },
                { reason: 'model_locked', model: 'qwen\n' }, { reason: 'credits_exhausted', requestId: 'not-a-uuid' },
                { reason: 'credits_exhausted', requestId: REQUEST_ID.toUpperCase() }, { reason: 'credits_exhausted', requestId: 42 },
                { reason: 'model_locked', model: 'qwen', message: 'private text' }, { reason: 'model_locked', [Symbol('x')]: 1 },
                { get reason() { return getter(); } }, Object.create({ reason: 'model_locked' })];
            for (const value of invalid) assert.equal(ask(value), false);
            assert.equal(events.length, 0); assert.equal(touched, 0);
            const original = window.dispatchEvent;
            window.dispatchEvent = () => { throw new Error('unavailable'); };
            assert.equal(ask({ reason: 'model_locked' }), false); window.dispatchEvent = original;
        });

        await t.test('billing intent: the shared records every layer reads (billing-intent-vectors.json)', () => {
            const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'billing-intent-vectors.json'), 'utf8'));
            assert.ok(vectors.accept.length >= 8 && vectors.reject.length >= 20);
            for (const { record, expect } of vectors.accept) {
                events.length = 0; takes = true;
                assert.equal(ask(record), true, JSON.stringify(record));
                assert.equal(events.length, 1);
                assert.deepEqual(JSON.parse(events[0].detail), expect);
            }
            events.length = 0;
            for (const record of vectors.reject) assert.equal(ask(record), false, JSON.stringify(record));
            assert.equal(events.length, 0);
        });

        const service = (models, hidden = []) => ({
            getLanguageModelIds: () => Object.keys(models), lookupLanguageModel: id => models[id], isModelHidden: id => hidden.includes(id),
        });
        await t.test('picker list: plan-locked rows are added once, after the picker\'s own rows; nothing else changes', () => {
            const flash = { identifier: 'ezil/ezil/gemini-3.8-flash', metadata: { id: 'ezil/gemini-3.8-flash', vendor: 'ezil', isUserSelectable: true } };
            const models = {
                'ezil/ezil/gemini-3.8-flash': flash.metadata,
                'ezil/qwen.qwen3-coder-next': locked('qwen.qwen3-coder-next'),
                'ezil/us.moonshotai.kimi-k3': locked('us.moonshotai.kimi-k3'),
                'ezil/hidden': locked('hidden'),
                'other/not-selectable': { id: 'not-selectable', isUserSelectable: false },
                'other/info-only': { id: 'info-only', isUserSelectable: true, infoText: { ezilPlanLocked: LOCK_TEXT } },
                'other/remote-session': locked('remote', { targetChatSessionType: 'cloud' }),
                'other/foreign-vendor': locked('foreign', { vendor: 'other' }),
                'other/other-info': { id: 'x', isUserSelectable: false, infoText: { other: 'text' } },
            };
            const listed = sandbox.ezilPickerModels(service(models, ['ezil/hidden']), [flash]);
            assert.deepEqual(listed.map(m => m.identifier), ['ezil/ezil/gemini-3.8-flash', 'ezil/qwen.qwen3-coder-next', 'ezil/us.moonshotai.kimi-k3']);
            assert.equal(listed[1].metadata, models['ezil/qwen.qwen3-coder-next']);
            // A locked row the picker already lists is not added twice; with none locked the picker's own array is returned.
            const already = [flash, { identifier: 'ezil/qwen.qwen3-coder-next', metadata: models['ezil/qwen.qwen3-coder-next'] }];
            assert.deepEqual(sandbox.ezilPickerModels(service(models, ['ezil/hidden']), already).map(m => m.identifier),
                ['ezil/ezil/gemini-3.8-flash', 'ezil/qwen.qwen3-coder-next', 'ezil/us.moonshotai.kimi-k3']);
            const plain = [flash];
            assert.equal(sandbox.ezilPickerModels(service({ 'ezil/ezil/gemini-3.8-flash': flash.metadata }), plain), plain);
            // A service that fails leaves the picker exactly as it was.
            assert.equal(sandbox.ezilPickerModels({ getLanguageModelIds: () => { throw new Error('x'); } }, plain), plain);
            // Only for a vendor the picker already lists: an empty picker (session models still loading, another
            // session type's pool, a mode or location without this vendor) gets no locked rows either.
            assert.equal(sandbox.ezilPickerModels(service(models), []).length, 0);
            const otherPool = [{ identifier: 'other/pool', metadata: { id: 'pool', vendor: 'other', isUserSelectable: true } }];
            assert.deepEqual(sandbox.ezilPickerModels(service(models), otherPool).map(m => m.identifier), ['other/pool', 'other/foreign-vendor']);
            assert.equal(sandbox.ezilPlanLocked({ metadata: locked('q') }), true);
            for (const model of [undefined, {}, { metadata: { isUserSelectable: false } }, { metadata: { ...locked('q'), isUserSelectable: true } },
                { metadata: { ...locked('q'), infoText: { ezilPlanLocked: 1 } } }, { metadata: locked('q', { targetChatSessionType: 'x' }) }]) {
                assert.equal(sandbox.ezilPlanLocked(model), false);
            }
        });

        await t.test('picker select: a locked row runs the extension command and selects nothing; any other row selects as before', async () => {
            const at = code.indexOf('c=ee=>{if(ezilPlanLocked(ee)){');
            const arrow = code.slice(at + 2, code.indexOf('this._onDidChangeSelection.fire(ee)}', at) + 'this._onDidChangeSelection.fire(ee)}'.length);
            const calls = [], logged = [], fired = [];
            const widget = {
                _selectedModel: { identifier: 'ezil/ezil/gemini-3.8-flash', metadata: { id: 'ezil/gemini-3.8-flash', isUserSelectable: true } },
                _delegate: { getChatSessionId: () => 'session' }, _renderLabel: () => calls.push('render'),
                _onDidChangeSelection: { fire: model => fired.push(model) },
                _commandService: { executeCommand: (...args) => { calls.push(args); return Promise.resolve('asked'); } },
            };
            const select = runInNewContext(`(function(){return ${arrow}}).call(widget)`,
                { ...sandbox, widget, a: { logModelChange: (...args) => logged.push(args) }, Promise });
            const previous = widget._selectedModel;
            select({ identifier: 'ezil/qwen.qwen3-coder-next', metadata: locked('qwen.qwen3-coder-next') });
            assert.deepEqual(calls, [['_ezil-models.lockedModel', 'qwen.qwen3-coder-next']]);
            assert.equal(widget._selectedModel, previous); assert.deepEqual(fired, []); assert.deepEqual(logged, []);
            // A command that fails (an older extension) never throws into the picker.
            widget._commandService.executeCommand = () => Promise.reject(new Error('no such command'));
            assert.doesNotThrow(() => select({ identifier: 'ezil/x', metadata: locked('x') }));
            await new Promise(resolve => setImmediate(resolve));
            calls.length = 0;
            const kimi = { identifier: 'ezil/us.moonshotai.kimi-k3', metadata: { id: 'us.moonshotai.kimi-k3', isUserSelectable: true } };
            select(kimi);
            assert.equal(widget._selectedModel, kimi); assert.deepEqual(fired, [kimi]); assert.equal(logged.length, 1); assert.deepEqual(calls, ['render']);
        });

        await t.test('pin: a locked row offers no pin unless already pinned; configure stops at a locked row', () => {
            const at = code.indexOf('makePinAction:n=>s.actions.onTogglePin&&');
            const expr = code.slice(at + 'makePinAction:'.length, code.indexOf(':void 0', at) + ':void 0'.length);
            const pins = [];
            const make = (pinned) => runInNewContext(`(${expr})`, { ...sandbox, s: { actions: { onTogglePin: () => {} }, pinnedModelIds: pinned },
                Lhn: (id, isPinned) => { pins.push([id, isPinned]); return { id }; } });
            const lockedRow = { identifier: 'ezil/qwen.qwen3-coder-next', metadata: locked('qwen.qwen3-coder-next') };
            const open = { identifier: 'ezil/ezil/gemini-3.8-flash', metadata: { id: 'ezil/gemini-3.8-flash', isUserSelectable: true } };
            assert.equal(make([])(lockedRow), undefined);
            assert.deepEqual(make([])(open), { id: open.identifier });
            assert.deepEqual(make(['ezil/qwen.qwen3-coder-next'])(lockedRow), { id: lockedRow.identifier }, 'a pin made earlier can still be removed');
            assert.deepEqual(pins, [[open.identifier, false], [lockedRow.identifier, true]]);
            const c0 = code.indexOf(',l=(ee,ae,he)=>{if(ezilPlanLocked(ee))return void c(ee);');
            const configure = code.slice(c0 + 3, code.indexOf('this._configuration.show(', c0)) + 'this._configuration.show(ae)}';
            const steps = [];
            const fn = runInNewContext(`(function(){return ${configure}}).call(widget)`, { ...sandbox,
                widget: { _actionWidgetService: { hide: () => steps.push('hide') }, _configuration: { show: () => steps.push('configure') } }, c: model => steps.push(['select', model.identifier]) });
            fn(lockedRow, {}, false);
            assert.deepEqual(steps, [['select', lockedRow.identifier]]);
            steps.length = 0; fn(open, {}, false);
            assert.deepEqual(steps, [['select', open.identifier], 'hide', 'configure']);
        });

        await t.test('verify rejects a bundle missing any of the plan-lock patches', () => {
            for (const [id, needle] of [['billing-intent-command', 'qe.registerCommand("_ezil.billingIntent",'],
                ['picker-locked-list', 'M=Bhn({models:ezilPickerModels(this._languageModelsService,u),'],
                ['picker-locked-pin', 'makePinAction:n=>s.actions.onTogglePin&&(!ezilPlanLocked(n)'],
                ['picker-locked-configure', ',l=(ee,ae,he)=>{if(ezilPlanLocked(ee))return void c(ee);'],
                ['picker-locked-select', 'c=ee=>{if(ezilPlanLocked(ee)){']]) {
                fs.writeFileSync(path.join(root, wb), code.replace(needle, `/*removed ${id}*/`));
                const result = run('--verify', root);
                assert.notEqual(result.status, 0, id);
            }
            fs.writeFileSync(path.join(root, wb), code);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
