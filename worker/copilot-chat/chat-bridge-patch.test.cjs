// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/chat-bridge-patch.test.cjs
// The [chat-bridge] step against the real code-server 4.141.0 bundle: it changes workbench.js by
// exactly its two hunks (undoing them gives back the bytes every earlier step produces, pinned below
// as the U6 served hash), inlines chat-bridge.js verbatim, stays inert behind
// ezil.chatBridge.enabled, and leaves the bundle parseable. Skips without a local pristine bundle.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb, 'out/vs/code/browser/workbench/workbench.css', 'out/server-main.js'];
// workbench.js after every step before [chat-bridge] (code-server 4.141.0, patch script at exact U6 75c0a46c; independently rebuilt from the pinned deb).
const BEFORE_BRIDGE_SHA256 = '9f1818b42d9475adfc024caeea2fafb8c91cc66eececcd3f5dad54a98f6dca26';
const A_CALL = 'this.updateSessionsControlVisibility();try{this._ezilChatHeader(e)}';
const R_CALL = 'this.updateSessionsControlVisibility();try{this._ezilChatBridge()}catch(f){this.logService.error("EZiL: chat bridge not registered",f)}try{this._ezilChatHeader(e)}';
const count = (text, needle) => text.split(needle).length - 1;

test('[chat-bridge] adds exactly its two hunks to the real workbench.js, inert by default', { skip: !source && 'COPILOT_TEST_ROOT not set' }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-chat-bridge-'));
    try {
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
            fs.copyFileSync(path.join(source, file), path.join(root, file));
        }
        const run = spawnSync('bash', [script, root], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.equal(run.status, 0, run.stderr);
        const verify = spawnSync('bash', [script, '--verify', root], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        assert.equal(verify.status, 0, verify.stderr);

        const patched = fs.readFileSync(path.join(root, wb), 'utf8');
        // The script inlines it through $(cat), which drops trailing newlines.
        const bridgeJs = fs.readFileSync(path.join(__dirname, 'chat-bridge.js'), 'utf8').replace(/\n+$/, '');
        const start = patched.indexOf('_ezilChatBridge(){');
        const end = patched.indexOf('createControls(e){let t=this.createSessionsControl(e),', start);
        assert.ok(start > 0 && end > start);
        const method = patched.slice(start, end);
        assert.ok(method.includes(`let b=(${bridgeJs})({`), 'chat-bridge.js is inlined verbatim');
        assert.ok(method.startsWith('_ezilChatBridge(){if(this.configurationService.getValue("ezil.chatBridge.enabled")!==!0||'), 'off unless the setting is true');
        assert.equal(count(patched, 'qe.registerCommand("_ezil.chatBridge.v1",'), 1);
        assert.equal(count(patched, R_CALL), 1);

        // The method as shipped, run against a fake pane and command registry (qe): the setting gates
        // registration, one bridge per window, and disposing the pane unregisters and releases it.
        const body = method.slice('_ezilChatBridge(){'.length, -1);
        const registered = new Map();
        const qe = { registerCommand: (id, fn) => { registered.set(id, fn); return { dispose: () => registered.delete(id) }; } };
        const disposables = [];
        const pane = (enabled) => ({
            configurationService: { getValue: (key) => (key === 'ezil.chatBridge.enabled' ? enabled : undefined) },
            chatService: { getLiveSessionItems: async () => [], getHistorySessionItems: async () => [] },
            chatWidgetService: { getWidgetBySessionResource: () => undefined },
            workspaceContextService: { getWorkspace: () => ({ folders: [{ uri: { toString: () => 'vscode-remote://remote/workspace' } }] }) },
            logService: { info() {}, error() {} },
            _register: (d) => disposables.push(d),
        });
        const fakeGlobal = {};
        const install = new Function('qe', 'globalThis', body);
        install.call(pane(undefined), qe, fakeGlobal);
        install.call(pane(false), qe, fakeGlobal);
        assert.equal(registered.size, 0, 'inert unless ezil.chatBridge.enabled is exactly true');
        install.call(pane(true), qe, fakeGlobal);
        install.call(pane(true), qe, fakeGlobal);
        assert.deepEqual([...registered.keys()], ['_ezil.chatBridge.v1']);
        assert.equal(disposables.length, 1, 'a second pane in the same window does not register a second bridge');
        await Promise.resolve(registered.get('_ezil.chatBridge.v1')({}, { op: 'hello' })).then((hello) => {
            assert.deepEqual(hello, { ok: true, protocol: 2, owner: null, workspaceFolders: ['vscode-remote://remote/workspace'] });
            disposables[0].dispose();
            assert.equal(registered.size, 0);
            assert.equal(fakeGlobal.__ezilChatBridgeV1, false);

            // Undo the two hunks: what remains must be byte-identical to the pre-bridge bundle.
            const undone = patched.replace(method, '').split(R_CALL).join(A_CALL);
            assert.equal(crypto.createHash('sha256').update(undone).digest('hex'), BEFORE_BRIDGE_SHA256);
        });
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
