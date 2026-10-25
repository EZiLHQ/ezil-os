// Run: node --test worker/copilot-chat/status-patch.test.cjs
// Set COPILOT_TEST_ROOT to an unmodified, locally extracted code-server 4.141.0 lib/vscode.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb, 'out/vs/code/browser/workbench/workbench.css'];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
test('pinned bundle applies and verifies; status strings replaced and legal notices retained', { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-status-patch-'));
    try {
        for (const file of files) { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
        for (const args of [[root], ['--verify', root]]) {
            const result = run(...args); assert.equal(result.status, 0, result.stdout + result.stderr);
            console.log(result.stdout.trim().split('\n').slice(-4).join('\n'));
        }
        for (const file of ['extensions/copilot/LICENSE.txt', 'product.json']) assert.deepEqual(fs.readFileSync(path.join(root, file)), fs.readFileSync(path.join(source, file)));
        const messages = JSON.parse(fs.readFileSync(path.join(root, 'out/nls.messages.json'), 'utf8'));
        for (const old of ['Copilot Free', 'Chat messages', 'Limited']) assert(!messages.includes(old), old);
        for (const next of ['EZiL AI', 'Gateway usage', 'View EZiL AI status']) assert(messages.includes(next), next);
        assert(messages.includes('AI responses may be inaccurate. Review changes before applying them.'));
        const code = fs.readFileSync(path.join(root, wb), 'utf8');
        await t.test('dashboard returns before GitHub account header or quota render', () => {
            const start = code.indexOf('static{this.QUICK_SETTINGS_COLLAPSED_KEY="chatStatusDashboard.quickSettingsCollapsed"}render(){');
            assert(start >= 0);
            const body = code.slice(start).split('render(){')[1].split('return;let e=Rh(this._store),')[0] + 'return;';
            const children = [], handlers = [];
            const context = { element: { replaceChildren: () => children.splice(0), appendChild: node => (children.push(node), node) }, _store: { add: value => value }, runCommandAndClose: command => handlers.push(command) };
            Object.defineProperty(context, 'chatEntitlementService', { get() { throw new Error('Copilot entitlement accessed'); } });
            new Function('_', 'q', body).call(context, (tag, attrs, text) => ({ tag, text }), (node, event, action) => { action(); });
            assert.deepEqual(handlers, ['ezil-models.showStatus']);
            assert.deepEqual(children.map(c => c.text), ['EZiL AI', 'Show credits and recent usage', 'AI responses may be inaccurate. Review changes before applying them.']);
        });
        await t.test('old status item is disposed without reading Copilot entitlements', () => {
            const body = code.match(/update\(\)\{if\(!0\)this\.entry\?\.dispose\(\),this\.entry=void 0;else\{let t=this\.getEntryProps\(\);.*?\}\}registerListeners/)[0].slice('update(){'.length, -'}registerListeners'.length);
            let disposed = false;
            const context = { entry: { dispose: () => { disposed = true; } }, getEntryProps: () => { throw new Error('unexpected old status'); } };
            new Function(body).call(context); assert(disposed); assert.equal(context.entry, undefined);
        });
        await t.test('verification rejects a restored quota label', () => {
            const file = path.join(root, 'out/nls.messages.json');
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"Gateway usage"', '"Chat messages"'));
            const result = run('--verify', root); assert.notEqual(result.status, 0); assert.match(result.stderr, /GATE FAILED \[ai-quota\]/);
        });
        await t.test('patch rejects a moved dashboard anchor', () => {
            fs.copyFileSync(path.join(source, wb), path.join(root, wb));
            fs.writeFileSync(path.join(root, wb), fs.readFileSync(path.join(root, wb), 'utf8').replace('chatStatusDashboard.quickSettingsCollapsed', 'upstreamMoved'));
            const result = run(root); assert.notEqual(result.status, 0); assert.match(result.stderr, /\[ai-dashboard\] anchor occurs 0 times/);
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
