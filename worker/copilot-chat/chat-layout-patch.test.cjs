// Run: COPILOT_TEST_ROOT=/path/to/pristine/lib/vscode node --test worker/copilot-chat/chat-layout-patch.test.cjs
// Applies patch-copilot-chat.sh to a copy of the pinned code-server 4.141.0 bundle and checks the
// compact chat layout (PATCHES.md "Compact chat layout"): the appended CSS, the Add Context menu move,
// and the injected ChatViewPane header method, executed against a minimal DOM double.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const css = 'out/vs/code/browser/workbench/workbench.css';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json', 'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb, css];
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const NOTICE = 'AI responses may be inaccurate. Review changes before applying them.';

// A DOM double with just what the header method touches.
class El {
  constructor(cls = '', doc) { this.className = cls; this.children = []; this.parentElement = null; this.listeners = {}; this.attrs = {}; this.ownerDocument = doc; this.offsetWidth = 0; this.title = ''; this.type = ''; }
  get classList() { const el = this; return { add: c => { if (!el.className.split(' ').includes(c)) el.className = (el.className + ' ' + c).trim(); }, contains: c => el.className.split(' ').includes(c) }; }
  detach() { if (this.parentElement) { const s = this.parentElement.children; s.splice(s.indexOf(this), 1); this.parentElement = null; } }
  append(...nodes) { for (const n of nodes) { n.detach(); n.parentElement = this; this.children.push(n); } }
  // Like the DOM: a reference node that is not a direct child throws (NotFoundError) before anything moves.
  insertBefore(n, ref) { if (ref && !this.children.includes(ref)) throw new Error('NotFoundError'); n.detach(); n.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(n); else this.children.splice(i, 0, n); }
  matches(sel) { return this.className.split(' ').includes(sel.replace(/^\./, '')); }
  querySelector(sel) { for (const c of this.children) { if (c.matches(sel)) return c; const d = c.querySelector(sel); if (d) return d; } return null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type, extra = {}) { const ev = { type, key: extra.key, stopped: false, prevented: false, stopPropagation() { this.stopped = true; }, preventDefault() { this.prevented = true; } }; for (const fn of this.listeners[type] ?? []) fn(ev); return ev; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
}
function fixture({ withSecondary = true, commandFails = false } = {}) {
  const observers = [];
  const doc = { createElement: tag => Object.assign(new El('', doc), { tagName: tag.toUpperCase() }), defaultView: { getComputedStyle: e => ({ paddingLeft: e.padL ?? '0px', paddingRight: '0px' }), ResizeObserver: class { constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = false; observers.push(this); } observe(e) { this.observed.push(e); } disconnect() { this.disconnected = true; } } } };
  const mk = cls => new El(cls, doc);
  const pane = mk('pane-body chat-viewpane'), wrapper = mk('voice-agent-controls-wrapper'), sessions = mk('agent-sessions-container'), controls = mk('chat-controls-container');
  pane.append(wrapper); wrapper.append(sessions, controls);
  const title = mk('chat-view-title-container visible'), inner = mk('chat-view-title-inner'), nav = mk('chat-view-title-navigation-toolbar'), actions = mk('chat-view-title-actions-toolbar');
  title.append(inner); inner.append(nav, actions);
  const session = mk('interactive-session'), part = mk('interactive-input-part'), inputContainer = mk('chat-input-container'), editor = mk('chat-editor-container'), monaco = mk('monaco-editor'), toolbars = mk('chat-input-toolbars');
  editor.append(monaco); editor.clientWidth = 721; editor.padL = '4px';
  const primary = mk('monaco-toolbar chat-input-toolbar'), execute = mk('monaco-toolbar chat-execute-toolbar'), secondary = mk('chat-secondary-toolbar');
  controls.append(title, session); session.append(part); part.append(inputContainer); inputContainer.append(editor, toolbars); toolbars.append(primary, execute);
  if (withSecondary) part.append(secondary);
  toolbars.offsetWidth = 48;
  // The input part lays the editor out at its own width estimate (779 px here) minus the trailing space.
  monaco.offsetWidth = 779;
  const calls = { commands: [], info: [], trailing: [], errors: [], registered: [] };
  const inputPart = { inputContainerElement: inputContainer, inputToolbarElement: primary, secondaryToolbarContainer: withSecondary ? secondary : undefined, setInputEditorTrailingSpace: px => { calls.trailing.push(px); monaco.offsetWidth = 779 - px; } };
  const view = {
    titleControl: { titleContainer: title }, _widget: { inputPart },
    commandService: { executeCommand: id => { calls.commands.push(id); return commandFails ? Promise.reject(new Error('command not found')) : Promise.resolve(); } },
    notificationService: { info: m => calls.info.push(m) },
    logService: { error: (m, e) => calls.errors.push([m, String(e)]) },
    _register: d => (calls.registered.push(d), d),
  };
  return { doc, pane, wrapper, sessions, controls, title, inner, nav, actions, primary, execute, secondary, toolbars, editor, monaco, view, calls, observers };
}

test('compact chat layout: CSS, Add Context move, header method', { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-chat-layout-'));
  try {
    for (const file of files) { const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(source, file), dest); }
    for (const args of [[root], ['--verify', root]]) { const r = run(...args); assert.equal(r.status, 0, r.stdout + r.stderr); }
    const code = fs.readFileSync(path.join(root, wb), 'utf8');
    const style = fs.readFileSync(path.join(root, css), 'utf8');

    await t.test('the notice under the input is gone; layout rules are appended once, scoped to the chat view', () => {
      assert(!style.includes('::after{content:"AI responses may be inaccurate.'));
      const tail = style.slice(style.lastIndexOf('\n.chat-viewpane.ezil-compact-chat>.chat-view-title-container'));
      const rules = tail.trim().split('}').filter(Boolean);
      assert(rules.length >= 10, String(rules.length));
      for (const r of rules) assert.match(r.trim(), /^\.chat-viewpane[.\s]/, r);
      assert.equal(style.split('.chat-viewpane .chat-getting-started-tip-container{display:none!important}').length, 2);
      assert.equal(style.split('.chat-viewpane.ezil-compact-chat .interactive-session>.interactive-input-part .chat-input-container{display:grid;').length, 2);
    });

    await t.test('Add Context for the chat view moves to the Send toolbar; quick chat and editor entries unchanged', () => {
      assert(code.includes('{when:T.and(J.inQuickChat.negate(),J.location.isEqualTo("panel"),T.or(J.lockedToCodingAgent.negate(),J.agentSupportsAttachments)),id:O.ChatExecute,group:"navigation",order:-1}'));
      assert(!code.includes('J.location.isEqualTo("panel"),T.or(J.lockedToCodingAgent.negate(),J.agentSupportsAttachments)),id:O.ChatInput,'));
      assert(code.includes('{when:T.and(J.inQuickChat,T.or(J.lockedToCodingAgent.negate(),J.agentSupportsAttachments)),id:O.ChatExecute,group:"navigation",order:-1}'));
      assert(code.includes('J.location.isEqualTo("editor"),o_e,T.or(J.lockedToCodingAgent.negate(),J.agentSupportsAttachments)),id:O.ChatInput,group:"navigation",order:2}'));
    });

    const start = code.indexOf('_ezilChatHeader(e){');
    const end = code.indexOf('}_updateVoiceBar(e){', start);
    assert(start > 0 && end > start);
    const header = new Function('e', code.slice(start + '_ezilChatHeader(e){'.length, end));
    const cStart = code.indexOf('createControls(e){'), cEnd = code.indexOf('}_ezilChatHeader(e){');
    const createControls = new Function('e', 'P3e', code.slice(cStart + 'createControls(e){'.length, cEnd));

    await t.test('header method moves the input part\'s own toolbars into the title row and puts it on top', async () => {
      const f = fixture();
      header.call(f.view, f.wrapper);
      assert.deepEqual(f.pane.children.map(c => c.className), ['chat-view-title-container visible', 'voice-agent-controls-wrapper']);
      assert(f.pane.classList.contains('ezil-compact-chat'));
      const h = f.inner.children[1];
      assert.equal(h.className, 'interactive-session ezil-chat-header');
      assert.deepEqual(f.inner.children.map(c => c.className.split(' ').pop()), ['chat-view-title-navigation-toolbar', 'ezil-chat-header', 'chat-view-title-actions-toolbar']);
      assert.equal(h.children[0].className, 'chat-input-toolbars');
      assert.equal(h.children[0].children[0], f.primary);
      assert.equal(h.children[1], f.secondary);
      assert.deepEqual(f.toolbars.children, [f.execute], 'the composer keeps the Send toolbar only');
      const help = h.children[2];
      assert.equal(help.tagName, 'BUTTON'); assert.equal(help.type, 'button');
      assert(help.getAttribute('aria-label').includes(NOTICE)); assert.equal(help.title, NOTICE);
      assert(h.dispatch('click').stopped, 'header clicks do not reach the title row (which focuses the input)');
      assert(h.dispatch('-monaco-gesturetap').stopped);
      help.dispatch('click'); assert.deepEqual(f.calls.commands, ['ezil-models.showStatus']);
      const enter = help.dispatch('keydown', { key: 'Enter' }); assert(enter.prevented && enter.stopped);
      help.dispatch('keydown', { key: ' ' }); help.dispatch('keydown', { key: 'a' });
      assert.deepEqual(f.calls.commands, ['ezil-models.showStatus', 'ezil-models.showStatus', 'ezil-models.showStatus']);
      assert.equal(f.observers.length, 1); assert.deepEqual(f.observers[0].observed, [f.editor, f.toolbars]);
      // The editor gets exactly its grid cell (721 px minus 4 px padding): trailing 779 - 717 = 62, then stable.
      f.observers[0].cb(); f.observers[0].cb(); assert.deepEqual(f.calls.trailing, [62]); assert.equal(f.monaco.offsetWidth, 717);
      f.editor.clientWidth = 701; f.observers[0].cb(); assert.deepEqual(f.calls.trailing, [62, 82]); assert.equal(f.monaco.offsetWidth, 697);
      f.calls.registered.forEach(d => d.dispose()); assert(f.observers[0].disconnected);
    });

    await t.test('notice falls back to a notification when EZiL AI status is unavailable', async () => {
      const f = fixture({ commandFails: true });
      header.call(f.view, f.wrapper);
      f.inner.children[1].children[2].dispatch('click');
      await new Promise(r => setTimeout(r, 0));
      assert.deepEqual(f.calls.info, [NOTICE]);
    });

    await t.test('without the pieces it needs it changes nothing', () => {
      const f = fixture({ withSecondary: false });
      header.call(f.view, f.wrapper);
      assert.deepEqual(f.pane.children.map(c => c.className), ['voice-agent-controls-wrapper']);
      assert(!f.pane.classList.contains('ezil-compact-chat'));
      assert.deepEqual(f.toolbars.children, [f.primary, f.execute]);
    });

    await t.test('a title row whose actions toolbar is nested deeper fails before any control moves (review MEDIUM-1)', () => {
      const f = fixture();
      const nested = new El('chat-view-title-actions-wrapper', f.doc);
      f.inner.append(nested); nested.append(f.actions);
      assert.throws(() => header.call(f.view, f.wrapper), /NotFoundError/);
      // Mode/model/tools and Local/permissions stay where upstream put them: nothing is half-moved or lost.
      assert.deepEqual(f.toolbars.children, [f.primary, f.execute]);
      assert.equal(f.secondary.parentElement.className, 'interactive-input-part');
      assert.deepEqual(f.inner.children.map(c => c.className), ['chat-view-title-navigation-toolbar', 'chat-view-title-actions-wrapper']);
    });

    await t.test('createControls still builds the view and contains a header failure', () => {
      const order = [];
      const view = {
        createSessionsControl: () => (order.push('sessions'), 's'), instantiationService: { createInstance: () => 'w' }, _register: x => x,
        createChatControl: () => (order.push('chat'), 'c'), registerControlsListeners: (...a) => order.push(['listeners', ...a]),
        updateSessionsControlVisibility: () => order.push('visibility'), _ezilChatHeader: () => { throw new Error('boom'); },
        logService: { error: (m) => order.push(['error', m]) },
      };
      createControls.call(view, {}, class {});
      assert.deepEqual(order, ['sessions', 'chat', ['listeners', 's', 'c', 'w'], 'visibility', ['error', 'EZiL: chat header layout not applied']]);
    });

    // The bundle's own picker options (SW), anchor layout (X7) and action widget sizing (computeHeight)
    // in a 900 px window: a header picker sits ~97 px from the top, a Chat editor composer's at ~779.
    await t.test('chat pickers open above when they fit and flip below in the header (picker-flip)', () => {
      const between = (from, to) => { const i = code.indexOf(from), j = code.indexOf(to, i); assert(i > 0 && j > i, from); return code.slice(i, j); };
      const SW = new Function('Vio', between('function SW(s){', '}function ') + '}return SW')(s => ({ ...s }));
      const X7 = new Function(between('function X7(', '}function ') + '}return X7')();
      const computeHeight = new Function('ke', 'slt', 'X7', 'return function(){' + between('computeHeight(){', '}layout(e,t){this._hasLaidOut=!0').slice('computeHeight(){'.length) + '}')(() => ({ innerHeight: 900, pageYOffset: 0 }), a => a, X7);
      assert(code.includes('this._anchorPosition=a?.anchorPosition,this._preferredAnchorPosition=a?.preferredAnchorPosition,'), 'the widget reads both options from the list options');
      assert(code.includes('G=r.closest(".monaco-dialog-box")?{...SW(K),anchorPosition:0}:SW(K)'), 'a picker in a dialog still forces below');
      // Six 22 px rows, the search box and (in a chat with turns) the 44 px cache-break hint.
      const open = (options, top, hint = true) => {
        const w = { _anchorPosition: options.anchorPosition, _preferredAnchorPosition: options.preferredAnchorPosition, _useFullHeight: options.useFullHeight ?? false, _anchor: { top, height: 22 }, domNode: {},
          _widget: { computeMaxVisibleItemsHeight: () => 132, computeListHeight: () => 132, computeMaxFullHeight: () => 132, filterContainer: {}, headerContainer: hint ? { hidden: false, offsetHeight: 44 } : undefined, lineHeight: 22 },
          hasDynamicHeight: () => false, computeActionWidgetVerticalChromeHeight: () => 2 };
        const list = computeHeight.call(w);
        return { above: w._showAbove, list };
      };
      assert.deepEqual(open(SW({}), 97), { above: false, list: 132 }, 'header picker in a chat with turns: below, every row');
      assert.deepEqual(open(SW({}), 97, false), { above: false, list: 132 }, 'header picker in an empty chat: below, every row');
      // SW alone picks the side, as upstream: the agent-host mode/permissions popup passes its own anchorPosition 1.
      assert.deepEqual(open(SW({ anchorPosition: 1, useFullHeight: true }), 97), { above: false, list: 132 }, 'a caller\'s anchorPosition does not pin a header picker above');
      assert.deepEqual(open(SW({}), 779), { above: true, list: 132 }, 'composer picker: still above');
      assert.deepEqual(open(SW({}), 300), { above: true, list: 132 }, 'mid-window picker that fits above: above');
      assert.deepEqual(open({ ...SW({}), anchorPosition: 0 }, 300), { above: false, list: 132 }, 'dialog picker at the same place: still forced below');
    });

    // The bundle's own responsive picker layout (SEt.layout), against a double of the header's picker row: the mode
    // picker (70 px, 22 compact), the model picker (134 px, 22 compact; the one canShrink item, which can ellipsize down
    // to 48 px) and the tools picker (22 px), 4 px apart, left to right. A phone's Chat leaves about 146 px for the row.
    await t.test('the model picker keeps its name in a narrow header; it compacts last (picker-order)', () => {
      const layoutOf = (bundle) => {
        const i = bundle.indexOf('layout(){if(this._isLayouting||!this._element.isConnected)return;'), j = bundle.indexOf('}areAllItemsCompact(){', i);
        assert(i > 0 && j > i, 'SEt.layout found');
        return new Function('return function(){' + bundle.slice(i + 'layout(){'.length, j) + '}')();
      };
      const row = (width, specs) => {
        const order = [];
        const items = specs.map(([name, left, full, compact, shrinkTo]) => ({ name, left, full, compact, shrinkTo, isCompact: false, canShrink: shrinkTo !== undefined,
          setCompact(v) { if (v && !this.isCompact) order.push(name); this.isCompact = v; }, setMinimal() {} }));
        const used = () => items.reduce((sum, it) => sum + (it.isCompact ? it.compact : it.canShrink ? it.shrinkTo : it.full), 0) + 4 * (items.length - 1);
        const self = {
          _isLayouting: false, _element: { isConnected: true, getBoundingClientRect: () => ({ width }) }, _mutationObserver: { disconnect() {} }, _observeMutations() {},
          _restoreCompactItems: () => true, _delegate: { relayout() {} },
          _getVisibleItemBounds: () => items.map(item => ({ item, bounds: { left: item.left } })),
          // Upstream's fit check: every item inside the row; a canShrink item may be narrower than its preferred width.
          _fitsAvailableWidth: (e) => used() <= e,
        };
        return { self, items, order };
      };
      const header = [['mode', 0, 70, 22], ['model', 74, 134, 22, 48], ['tools', 212, 22, 22]];
      const patched = layoutOf(code), pristine = layoutOf(fs.readFileSync(path.join(source, wb), 'utf8'));
      const phone = row(146, header); patched.call(phone.self);
      assert.deepEqual(phone.order, ['tools', 'mode'], 'phone: the tools and mode pickers become icons; the model picker is not compacted');
      assert.equal(phone.items[1].isCompact, false, 'phone: the model picker keeps its (ellipsized) name');
      const before = row(146, header); pristine.call(before.self);
      assert.deepEqual(before.order, ['tools', 'model'], 'unpatched: the model picker, right of the mode picker, lost its name first');
      for (const layout of [patched, pristine]) { const wide = row(300, header); layout.call(wide.self); assert.deepEqual(wide.order, [], 'desktop: everything fits, nothing compacts'); }
      const tiny = row(60, header); patched.call(tiny.self);
      assert.deepEqual(tiny.order, ['tools', 'mode', 'model'], 'too narrow even for an ellipsized name: the model picker compacts last');
      // A row without a canShrink item (the Local/permissions row) compacts right to left, exactly as upstream.
      const secondary = [['local', 0, 60, 22], ['permissions', 64, 90, 22], ['context', 158, 40, 22]];
      const a = row(120, secondary), b = row(120, secondary); patched.call(a.self); pristine.call(b.self);
      assert.deepEqual(a.order, b.order); assert.deepEqual(a.order, ['context', 'permissions']);
    });

    await t.test('patch rejects a moved header anchor', () => {
      fs.copyFileSync(path.join(source, wb), path.join(root, wb));
      fs.copyFileSync(path.join(source, css), path.join(root, css));
      for (const f of ['out/nls.messages.js', 'out/nls.messages.json', 'extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json']) fs.copyFileSync(path.join(source, f), path.join(root, f));
      fs.writeFileSync(path.join(root, wb), fs.readFileSync(path.join(root, wb), 'utf8').replace('this.registerControlsListeners(t,n,i),this.updateSessionsControlVisibility()}', 'this.updateSessionsControlVisibility(),this.registerControlsListeners(t,n,i)}'));
      const r = run(root); assert.notEqual(r.status, 0); assert.match(r.stderr, /\[chat-header\] anchor occurs 0 times/);
    });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
