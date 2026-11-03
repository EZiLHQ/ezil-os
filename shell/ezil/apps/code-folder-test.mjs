// code-folder-test.mjs — EZiL-authored. Per-tab Code folder continuity, the shell side
// (`./code-folder.js`), against a fake iframe/window/sessionStorage/document:
//   - the shared path grammar (docs/contracts/code-folder-v1.vectors.json);
//   - the instance binding: mint id + per-hello nonce + origin + source + unchanged src,
//     in BOTH load orderings, and a stale earlier document dropped;
//   - the record rules (a transient miss never erases; Close Folder clears; multi-root
//     announced; a project child announced, never asked; an ask whose first document
//     opened anything else, or the asked folder after a definite non-restore, is always
//     said, once per mint);
//   - the notice band (text only, actions wired; `unverified` offers no Try again);
//   - storage that throws never breaks the window.
//
// Run: node --experimental-strip-types shell/ezil/apps/code-folder-test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const store = new Map();
globalThis.sessionStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) };
const listeners = new Set();
globalThis.window = { addEventListener: (t, f) => t === 'message' && listeners.add(f), removeEventListener: (t, f) => listeners.delete(f) };
const M = await import('./code-folder.js');

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks += 1; };
const eq = (a, b, msg) => { assert.deepStrictEqual(a, b, msg); checks += 1; };

// ── 0. the shared grammar ───────────────────────────────────────────────────
const V = JSON.parse(readFileSync(new URL('../../../docs/contracts/code-folder-v1.vectors.json', import.meta.url), 'utf8'));
const GENERATED = {
    SEGMENT_256_BYTES: `/workspace/${'a'.repeat(256)}`,
    PATH_2049_BYTES: `/${`${'b'.repeat(200)}/`.repeat(10)}${'c'.repeat(38)}`,
    SEGMENTS_65: `/${Array(65).fill('d').join('/')}`,
};
eq(Object.keys(V.plainFolderPath.generated).sort(), Object.keys(GENERATED).sort(), 'every generated vector has a generator');
for ( const [input, want] of V.plainFolderPath.accept ) eq(M.plainFolderPath(input), want, `accept ${JSON.stringify(input)}`);
for ( const raw of V.plainFolderPath.reject ) eq(M.plainFolderPath(GENERATED[raw] ?? raw), null, `reject ${JSON.stringify(raw)}`);
eq(M.MINT_PARAM, 'ezil_mint', 'the mint param name');
ok(V.bootstrapPathRefusedKeys.includes(M.MINT_PARAM), 'the Worker refuses the mint id hidden in a bootstrap path');

// ── the fake frame ──────────────────────────────────────────────────────────
const ORIGIN = 'https://aws-8443-guac-a-b-aws.ezil.work';
const minted = (t) => `${ORIGIN}/preview-bootstrap?token=${t}&path=%2F`;
const mintOf = (u) => new URL(u).searchParams.get('ezil_mint');
function frame () {
    const sent = []; const loadL = new Set(); const cw = { postMessage: (m, o) => sent.push({ m, o }) };
    return { sent, cw, isConnected: true, src: 'about:blank', get contentWindow () { return cw; },
        addEventListener: (t, f) => t === 'load' && loadL.add(f), removeEventListener: (t, f) => loadL.delete(f),
        load () { [...loadL].forEach(f => f()); }, loadListeners: () => loadL.size };
}
let F = frame();
const fire = (data, ev = {}) => [...listeners].forEach(f => f({ source: ev.source ?? F.cw, origin: ev.origin ?? ORIGIN, data }));
const report = (mint, kind, path, nonce = F.sent.at(-1).m.nonce) => fire({ type: 'ezil.code.folder', v: 1, nonce, mint, kind, ...(path ? { path } : {}) });
const bind = { userId: 'u1', computerId: 'c1', project: null };
const notices = []; const notice = { fallback: (o, p) => notices.push([o, p]), projectChild: p => notices.push(['child', p]) };
const mintAndAttach = (t, asked, answer, { attachFirst = true, b = bind } = {}) => {
    const url = M.tagFolderMint(minted(t), { asked, answer }); F.src = url;
    if ( attachFirst ) M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: b, notice });
    return url;
};

// 1 no record -> no ask; the tagged URL keeps the minted one and adds a 22-char mint id; hello targets the minted origin
eq(M.folderAskFor(bind), undefined, 'no record, no ask');
let url = mintAndAttach('t1', undefined, undefined);
ok(/^[A-Za-z0-9_-]{22}$/.test(mintOf(url)), 'a 22-char base64url mint id');
eq(new URL(url).searchParams.get('token'), 't1', 'the minted token is kept');
eq(F.sent.at(-1).o, ORIGIN, 'hello goes to the minted origin, never *');
eq(F.sent.at(-1).m.type, 'ezil.code.hello', 'hello');
// 1b the minted URL stays a byte-for-byte prefix (no re-encoding of the token or folder; nothing grows but the id)
const raw = `${ORIGIN}/preview-bootstrap?token=t%3D1%2Cv1%3Dab&folder=/workspace/projects/x`;
const tagged = M.tagFolderMint(raw, {});
ok(tagged.startsWith(`${raw}&ezil_mint=`) && tagged.length === raw.length + '&ezil_mint='.length + 22, 'appended as text');
ok(/^https:\/\/h\/p\?ezil_mint=[A-Za-z0-9_-]{22}$/.test(M.tagFolderMint('https://h/p', {})), 'no query: ?ezil_mint');
ok(/^https:\/\/h\/p\?ezil_mint=[A-Za-z0-9_-]{22}$/.test(M.tagFolderMint('https://h/p?', {})), 'empty query: no double ?');
eq(new URL(M.tagFolderMint('https://h/p?a=1#x', {})).hash, '#x', 'a hash stays a hash');
eq(new URL(M.tagFolderMint('https://h/p?ezil_mint=old', {})).searchParams.getAll('ezil_mint').length, 1, 'one id only');
eq(M.tagFolderMint('not a url', {}), 'not a url', 'an unparsable URL is returned unchanged');
// 2 ORDERING A: attached before the first load; the load re-hellos; the first document reports this mint -> stored
F.load(); report(mintOf(url), 'folder', '/workspace/sports/sports-web');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/sports/sports-web' }, 'mint-driven first report stored');
// 3 refusals: wrong origin, wrong source, wrong nonce
F.load(); const n = F.sent.at(-1).m.nonce;
fire({ type: 'ezil.code.folder', v: 1, nonce: n, mint: null, kind: 'folder', path: '/workspace/x' }, { origin: 'https://evil.example' });
fire({ type: 'ezil.code.folder', v: 1, nonce: n, mint: null, kind: 'folder', path: '/workspace/x' }, { source: {} });
report(null, 'folder', '/workspace/x', 'B'.repeat(22));
fire({ type: 'ezil.code.folder', v: 2, nonce: n, mint: null, kind: 'folder', path: '/workspace/x' });
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/sports/sports-web' }, 'origin/source/nonce/version refusals change nothing');
// 4 user-driven Open Folder (mint dropped -> null) after the first document: replaces (spaces + Unicode); a replayed nonce is ignored
report(null, 'folder', '/workspace/My Project/日本');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/My Project/日本' }, 'user-driven replace');
report(null, 'folder', '/workspace/replayed', n);
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/My Project/日本' }, 'replayed nonce ignored');
// 5 isolation: other computer / other user / no user
eq(M.folderAskFor({ ...bind, computerId: 'c2' }), undefined, 'other computer');
eq(M.folderAskFor({ ...bind, userId: 'u2' }), undefined, 'other user');
eq(M.folderAskFor({ ...bind, userId: undefined }), undefined, 'no user, no record');
// 6 STALE PRIOR DOCUMENT: a re-mint over a live editor attaches before the new document commits; the old document
//   answers the new hello with its own (null) mint -> dropped; then the new first document is mint-driven
url = mintAndAttach('t2', M.folderAskFor(bind), { v: 1, outcome: 'missing' });
report(null, 'folder', '/workspace/stale-old-doc');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/My Project/日本' }, 'stale earlier document dropped');
// 7 fallback (missing): the first document shows the default -> notice, record KEPT
F.load(); report(mintOf(url), 'folder', '/workspace');
eq(notices.at(-1), ['missing', '/workspace/My Project/日本'], 'missing notice');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/My Project/日本' }, 'a transient miss never erases the record');
// 8 ORDERING B: the first load fired before attach (the server confirmed late) -> attach's own hello reaches the first
//   document, which reports mint-driven; restored -> no notice
url = mintAndAttach('t3', M.folderAskFor(bind), { v: 1, outcome: 'restored' }, { attachFirst: false });
M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind, notice }); let before = notices.length;
report(mintOf(url), 'folder', '/workspace/My Project/日本'); eq(notices.length, before, 'restored: no notice');
// 9 a stale binding: src replaced by a newer mint -> the old binding drops messages and detaches
const oldNonce = F.sent.at(-1).m.nonce; F.src = M.tagFolderMint(minted('t4'), {});
fire({ type: 'ezil.code.folder', v: 1, nonce: oldNonce, mint: null, kind: 'folder', path: '/workspace/stale' });
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/My Project/日本' }, 'replaced src: dropped');
eq(listeners.size, 0, 'and the stale binding detached itself');
// 10 an older server ignored the ask but its default equals it -> no notice; one that differs says unsupported_server
url = mintAndAttach('t5', M.folderAskFor(bind), undefined); F.load(); before = notices.length;
report(mintOf(url), 'folder', '/workspace/My Project/日本'); eq(notices.length, before, 'old server, same folder: no notice');
url = mintAndAttach('t5b', M.folderAskFor(bind), undefined); F.load();
report(mintOf(url), 'folder', '/workspace'); eq(notices.at(-1), ['unsupported_server', '/workspace/My Project/日本'], 'old server, other folder: said');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/My Project/日本' }, 'and the record is kept');
// 11 Close Folder clears; multi-root / foreign mark unsupported, announced and dropped on the next bind
F.load(); report(mintOf(url), 'folder', '/workspace/My Project/日本'); // first document seen
F.load(); report(null, 'empty'); eq(M.folderAskFor(bind), undefined, 'Close Folder clears');
F.load(); report(null, 'workspace'); eq(M.readFolderRecord(bind).kind, 'unsupported', 'multi-root marked');
url = mintAndAttach('t6', M.folderAskFor(bind), undefined);
eq(notices.at(-1), ['unsupported', null], 'multi-root announced'); eq(M.readFolderRecord(bind), null, 'then dropped');
// 11b a mint-driven empty after an ask never erases the record, and it is SAID: the bridge reads the workspace
//     synchronously from the document's URL at startup, so an empty first document is the mint's final answer.
//     The server said restored, so the shell-local not_reopened (never the "couldn't check" text).
F.load(); report(mintOf(url), 'folder', '/workspace/keep'); url = mintAndAttach('t6b', M.folderAskFor(bind), { v: 1, outcome: 'restored' });
before = notices.length;
F.load(); report(mintOf(url), 'empty'); eq(M.folderAskFor(bind), { v: 1, path: '/workspace/keep' }, 'mint-driven empty keeps the record');
eq(notices.slice(before), [['not_reopened', '/workspace/keep']], 'restored, but the first document is empty: not_reopened notice');
// 11c an invalid path from the editor never becomes an ask
F.load(); report(null, 'folder', '/workspace/../etc'); eq(M.folderAskFor(bind), undefined, 'invalid path stored as unsupported, never asked');
eq(M.readFolderRecord(bind).kind, 'unsupported', 'unsupported:path');
// 11d EVERY first document that is not exactly the asked folder shows the notice and leaves the record untouched:
//     empty, workspace, foreign, a path the grammar refuses, another folder (review-folder blocking finding)
M.forgetFolder(bind);
url = mintAndAttach('t9', undefined, undefined); F.load(); report(mintOf(url), 'folder', '/workspace/sub');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/sub' }, 'seeded /workspace/sub');
for ( const [kind, path] of [['empty'], ['workspace'], ['foreign'], ['folder', '/workspace/../etc'], ['folder', '/workspace']] ) {
    const what = `asked, first document ${kind}${path ? ` ${path}` : ''}`;
    url = mintAndAttach(`t9-${kind}`, M.folderAskFor(bind), { v: 1, outcome: 'unverified' }); before = notices.length;
    F.load(); report(mintOf(url), kind, path);
    eq(notices.slice(before), [['unverified', '/workspace/sub']], `${what}: the notice is shown`);
    eq(M.readFolderRecord(bind)?.kind, 'folder', `${what}: the record stays a folder`);
    eq(M.folderAskFor(bind), { v: 1, path: '/workspace/sub' }, `${what}: the next mint asks again`);
}
// 11e one notice per mint, even when the first document answers more than one hello (attach, ready, load); a later
//     Open Folder by hand in that window still records
url = mintAndAttach('t10', M.folderAskFor(bind), { v: 1, outcome: 'missing' }); before = notices.length;
F.load(); report(mintOf(url), 'empty'); fire({ type: 'ezil.code.ready', v: 1 }); report(mintOf(url), 'empty');
eq(notices.slice(before), [['missing', '/workspace/sub']], 'one notice for the mint, not one per hello');
F.load(); report(null, 'folder', '/workspace/other'); eq(M.folderAskFor(bind), { v: 1, path: '/workspace/other' }, 'then a hand-opened folder records');
// 11f restored, but a workspace or another folder opened: not_reopened (shell-local), never "couldn't check"
url = mintAndAttach('t11', M.folderAskFor(bind), { v: 1, outcome: 'restored' }); F.load(); report(mintOf(url), 'workspace');
eq(notices.at(-1), ['not_reopened', '/workspace/other'], 'restored + workspace: not_reopened');
url = mintAndAttach('t11b', M.folderAskFor(bind), { v: 1, outcome: 'restored' }); F.load(); report(mintOf(url), 'folder', '/workspace');
eq(notices.at(-1), ['not_reopened', '/workspace/other'], 'restored + another folder: not_reopened');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/other' }, 'and the record is kept');
// 11g a mint that asked nothing stays silent whatever its first document is, and writes nothing for empty/workspace
M.forgetFolder(bind);
for ( const kind of ['empty', 'workspace', 'foreign'] ) {
    url = mintAndAttach(`t12-${kind}`, M.folderAskFor(bind), undefined); before = notices.length;
    F.load(); report(mintOf(url), kind);
    eq(notices.length, before, `no ask, first document ${kind}: no notice`); eq(M.readFolderRecord(bind), null, `no ask, ${kind}: nothing written`);
}
// 11h the first document is EXACTLY the asked folder but the server found it missing or not a directory: no folder=
//     was added, so the editor opened its own last folder, the asked one, and shows only VS Code's own "does not
//     exist". Said, once per mint, and the record untouched (`at` included). Every other outcome with a matching
//     report has that folder on screen (the editor's own pick): silent.
url = mintAndAttach('t13', undefined, undefined); F.load(); report(mintOf(url), 'folder', '/workspace/sub');
const seeded = M.readFolderRecord(bind); eq(seeded?.path, '/workspace/sub', 'seeded /workspace/sub');
const realNow = Date.now; Date.now = () => seeded.at + 60_000; // a write that falls through would move `at`
for ( const outcome of ['missing', 'not_directory'] ) {
    url = mintAndAttach(`t13-${outcome}`, M.folderAskFor(bind), { v: 1, outcome }); before = notices.length;
    F.load(); report(mintOf(url), 'folder', '/workspace/sub');
    eq(notices.slice(before), [[outcome, '/workspace/sub']], `${outcome} + the asked folder on screen: the notice is shown`);
    eq(M.readFolderRecord(bind), seeded, `${outcome} + the asked folder on screen: the record is untouched`);
}
url = mintAndAttach('t14', M.folderAskFor(bind), { v: 1, outcome: 'missing' }); before = notices.length;
F.load(); report(mintOf(url), 'folder', '/workspace/sub'); fire({ type: 'ezil.code.ready', v: 1 }); report(mintOf(url), 'folder', '/workspace/sub');
eq(notices.slice(before), [['missing', '/workspace/sub']], 'missing + the asked folder on screen: one notice for the mint, not one per hello');
eq(M.readFolderRecord(bind), seeded, 'and the record is still untouched');
const silent = ['restored', 'unverified', 'symlink', 'outside', 'not_allowed', 'invalid', 'too_long', 'error', 'later_code'];
for ( const [i, answer] of [...silent.map(outcome => ({ v: 1, outcome })), undefined].entries() ) {
    const what = answer?.outcome ?? 'no answer';
    url = mintAndAttach(`t15-${i}`, M.folderAskFor(bind), answer); before = notices.length;
    F.load(); report(mintOf(url), 'folder', '/workspace/sub');
    eq(notices.length, before, `${what} + the asked folder on screen: no notice`);
    eq(M.folderAskFor(bind), { v: 1, path: '/workspace/sub' }, `${what} + the asked folder on screen: still asked`);
}
Date.now = realNow; M.forgetFolder(bind);
// 12 a project tab never asks; a hand-opened child is announced once on the next mint, then follows the screen
const pb = { userId: 'u1', computerId: 'c1', project: { projectId: '0b0e9b8e-6b1f-4c5e-9d3a-2f1e8c7d6a5b', repoId: '1b0e9b8e-6b1f-4c5e-9d3a-2f1e8c7d6a5b' } };
const PF = `/workspace/projects/${pb.project.repoId}`;
url = mintAndAttach('p1', M.folderAskFor(pb), undefined, { b: pb }); F.load(); report(mintOf(url), 'folder', PF);
F.load(); report(null, 'folder', `${PF}/repository/web`); eq(M.folderAskFor(pb), undefined, 'a project tab never asks');
url = mintAndAttach('p2', undefined, undefined, { b: pb }); F.load(); report(mintOf(url), 'folder', PF);
eq(notices.at(-1), ['child', `${PF}/repository/web`], 'project child announced');
before = notices.length; url = mintAndAttach('p3', undefined, undefined, { b: pb }); F.load(); report(mintOf(url), 'folder', PF);
eq(notices.length, before, 'announced once, then follows the screen');
// 13 no mint id on the frame URL (an older Worker bootstrap) -> no binding at all
F.src = minted('nomint'); let sent = F.sent.length; const lBefore = listeners.size;
M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind, notice }); eq(F.sent.length, sent, 'no mint id: no hello');
// (the attach above detached the previous binding before giving up)
ok(listeners.size <= lBefore, 'no listener added without a mint id');
// 14 a report without the mint id before the first document is dropped (it cannot be told from a stale one)
url = mintAndAttach('t7', undefined, undefined); F.load(); report(null, 'folder', '/workspace/early');
eq(M.readFolderRecord(bind), null, 'mint null before the first report: dropped (nothing written)');
// 15 ezil.code.ready re-hellos with a fresh nonce
sent = F.sent.length; fire({ type: 'ezil.code.ready', v: 1 }); eq(F.sent.length, sent + 1, 'ready -> hello');
ok(F.sent.at(-1).m.nonce !== F.sent.at(-2).m.nonce, 'fresh nonce per hello');
// 16 detachFolderBridge (the window closed) removes every listener
M.detachFolderBridge(F); eq(listeners.size, 0, 'detach: no message listener'); eq(F.loadListeners(), 0, 'detach: no load listener');
// 17 an unknown answer code from the server is not trusted
url = mintAndAttach('t8', { v: 1, path: '/workspace/a' }, { v: 1, outcome: '/etc/passwd' }); F.load(); report(mintOf(url), 'folder', '/workspace');
eq(notices.at(-1)[0], 'unsupported_server', 'a non-code answer is treated as no answer');
M.detachFolderBridge(F);
// 18 F2: the editor's own document URL, the user-driven change callback, and a continued (re-inserted) frame
const DOC = (q) => `${ORIGIN}${q}`;
eq(M.editorDocumentUrl(minted('x'), { kind: 'folder', path: '/workspace/a b/日本', base: '/' }),
    DOC('/?folder=%2Fworkspace%2Fa+b%2F%E6%97%A5%E6%9C%AC'), 'folder: frame origin + base + folder=');
eq(M.editorDocumentUrl(minted('x'), { kind: 'folder', path: '/workspace/a/', base: '/preview/' }), DOC('/preview/?folder=%2Fworkspace%2Fa'),
    'the Cloudflare document path, folder normalised');
eq(M.editorDocumentUrl(minted('x'), { kind: 'empty', base: '/preview/' }), DOC('/preview/?ew=true'), 'empty window: ew=true');
for ( const base of [undefined, '', 'preview/', '//evil.example/', '/a/../', '/./', '/a//', '/a?x=1/', '/a#/', '/%2e%2e/', '/a', `/${'a/'.repeat(5)}`, 5, '/\\/'] ) {
    eq(M.editorDocumentUrl(minted('x'), { kind: 'folder', path: '/workspace/a', base }), null, `base ${JSON.stringify(base)} refused`);
}
for ( const r of [{ kind: 'folder', path: '/workspace/../etc', base: '/' }, { kind: 'workspace', base: '/' }, { kind: 'foreign', base: '/' }, null] ) {
    eq(M.editorDocumentUrl(minted('x'), r), null, `report ${JSON.stringify(r)}: no URL`);
}
eq(M.editorDocumentUrl('not a url', { kind: 'empty', base: '/' }), null, 'unparsable frame URL: no URL');
const follows = [];
const attachF2 = (t) => {
    const u = M.tagFolderMint(minted(t), {}); F.src = u;
    M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind, notice, onUserFolder: (x) => follows.push(x) });
    return u;
};
const reportB = (mint, kind, path, base) => fire({ type: 'ezil.code.folder', v: 1, nonce: F.sent.at(-1).m.nonce, mint, kind, ...(path ? { path } : {}), ...(base ? { base } : {}) });
url = attachF2('t9'); F.load(); reportB(mintOf(url), 'folder', '/workspace/a', '/');
eq(follows, [], 'the mint\'s first document is not a change');
F.load(); reportB(null, 'folder', '/workspace/a', '/'); eq(follows, [], 'the same folder again is not a change');
F.load(); reportB(null, 'folder', '/workspace/b', '/'); eq(follows, [{ url: DOC('/?folder=%2Fworkspace%2Fb') }], 'Open Folder in the frame: one change, with its URL');
F.load(); reportB(null, 'empty', null, '/'); eq(follows.at(-1), { url: DOC('/?ew=true') }, 'Close Folder: a change to the empty window');
F.load(); reportB(null, 'folder', '/workspace/c'); eq(follows.at(-1), { url: null }, 'no document path from the editor: a change without a URL');
F.load(); reportB(null, 'workspace', null, '/'); eq(follows.length, 3, 'a workspace document is no folder change');
M.detachFolderBridge(F);
// A continued frame (re-inserted at the editor's own URL, no mint): its first report is the folder it was loaded at
// (no change, so no reload loop); later user-driven changes are heard and recorded.
follows.length = 0; F.src = DOC('/?folder=%2Fworkspace%2Fb');
M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind, notice, onUserFolder: (x) => follows.push(x), continued: true });
ok(F.sent.at(-1)?.m?.type === 'ezil.code.hello' && F.sent.at(-1).o === ORIGIN, 'continued: hello to the frame origin');
F.load(); reportB(null, 'folder', '/workspace/b', '/'); eq(follows, [], 'continued: its first document is no change');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/b' }, 'continued: the record follows the screen');
F.load(); reportB(null, 'folder', '/workspace/d', '/'); eq(follows, [{ url: DOC('/?folder=%2Fworkspace%2Fd') }], 'continued: a later Open Folder is heard');
F.load(); reportB(mintOf(url), 'folder', '/workspace/a', '/'); eq(M.folderAskFor(bind), { v: 1, path: '/workspace/d' }, 'continued: an earlier mint\'s document is dropped');
M.detachFolderBridge(F);
// loadFrame: a frame with no document gets `src`; a live one is removed and inserted again at the same place
const host = { kids: [], insertBefore (el, next) { const i = next ? this.kids.indexOf(next) : -1; this.kids.splice(i < 0 ? this.kids.length : i, 0, el); el.parentNode = this; } };
const el = (name) => ({ name, parentNode: null, attrs: {}, src: '', getAttribute (k) { return this.attrs[k] ?? null; },
    get nextSibling () { const k = this.parentNode?.kids; return k ? k[k.indexOf(this) + 1] ?? null : null; }, remove () { const i = this.parentNode.kids.indexOf(this); this.parentNode.kids.splice(i, 1); this.parentNode = null; this.removed = (this.removed ?? 0) + 1; } });
const fr = el('frame'); const after = el('notice'); host.insertBefore(fr, null); host.insertBefore(after, null);
Object.defineProperty(fr, 'src', { get () { return this.attrs.src ?? ''; }, set (v) { this.attrs.src = v; this.assigned = [...(this.assigned ?? []), { v, connected: !! this.parentNode }]; } });
M.loadFrame(fr, 'https://h/first'); eq(fr.removed, undefined, 'no document yet: not re-inserted'); eq(fr.assigned, [{ v: 'https://h/first', connected: true }], 'src set in place');
M.loadFrame(fr, 'https://h/second'); eq(fr.removed, 1, 'a live frame is removed once');
eq(fr.assigned.at(-1), { v: 'https://h/second', connected: false }, 'its src is set while detached (no navigation of the old frame)');
eq(host.kids.map(k => k.name), ['frame', 'notice'], 'inserted again at the same place, before its next sibling');

// ── the notice band: text only, actions per outcome ─────────────────────────
globalThis.document = { createElement: (t) => ({ t, children: [], attrs: {}, listeners: {}, className: '', textContent: '',
    appendChild (c) { this.children.push(c); }, setAttribute (k, v) { this.attrs[k] = v; }, addEventListener (k, f) { this.listeners[k] = f; },
    remove () { this.removed = true; } }) };
const body = { children: [], appendChild (c) { this.children.push(c); } };
let retried = 0, forgot = 0;
const nb = M.createFolderNotice(body, { retry: () => retried++, forget: () => forgot++ });
nb.fallback('missing', '/workspace/My <b>Project</b>');
const band = body.children.at(-1);
eq(band.attrs.role, 'status', 'role=status'); eq(band.attrs['aria-live'], 'polite', 'polite');
eq(band.className, 'ezil-code-folder-notice', 'styled by class, never inline');
ok(/“\/workspace\/My <b>Project<\/b>”/.test(band.children[0].textContent), 'markup stays text');
eq(band.children.slice(1).map(b => b.textContent), ['Try again', 'Forget it', 'Dismiss'], 'missing: Try again, Forget it, Dismiss');
band.children[1].listeners.click(); band.children[2].listeners.click(); eq([retried, forgot], [1, 1], 'actions wired');
ok(band.removed, 'an action closes the band');
nb.projectChild(`${PF}/repository/web`); eq(body.children.at(-1).children.slice(1).map(b => b.textContent), ['Dismiss'], 'child: Dismiss only');
nb.fallback('symlink', '/workspace/link'); eq(body.children.at(-1).children.slice(1).map(b => b.textContent), ['Forget it', 'Dismiss'], 'symlink: not retryable');
nb.fallback('unsupported', null); eq(body.children.at(-1).children.slice(1).map(b => b.textContent), ['Dismiss'], 'unsupported: Dismiss');
// No resolver is wired yet, so a re-mint answers `unverified` again: the notice stays, Try again does not.
nb.fallback('unverified', '/workspace/sub');
eq(body.children.at(-1).children.slice(1).map(b => b.textContent), ['Forget it', 'Dismiss'], 'unverified: no Try again');
ok(/couldn't check “\/workspace\/sub”/.test(body.children.at(-1).children[0].textContent), 'unverified: the notice is still said');
nb.fallback('too_long', `/workspace/${'x'.repeat(300)}`); ok(body.children.at(-1).children[0].textContent.includes('…'), 'a long path is shortened');
nb.fallback('not_reopened', '/workspace/sub');
eq(body.children.at(-1).children.slice(1).map(b => b.textContent), ['Try again', 'Forget it', 'Dismiss'], 'not_reopened: Try again, Forget it, Dismiss');
ok(/didn't reopen “\/workspace\/sub”/.test(body.children.at(-1).children[0].textContent), 'not_reopened has its own text');
// No notice promises unsaved changes back (hot-exit backups live in code-server's user-data dir, which a Cloudflare
// container recreates on start); "Nothing was deleted" is what is known.
for ( const code of ['missing', 'not_directory', 'unverified', 'not_reopened', 'outside', 'symlink', 'child'] ) {
    if ( code === 'child' ) nb.projectChild('/workspace/projects/x/repository/web'); else nb.fallback(code, '/workspace/sub');
    ok(! /unsaved|come back/i.test(body.children.at(-1).children[0].textContent), `${code}: no recovery promise`);
}
nb.close(); ok(body.children.at(-1).removed, 'close');

// ── storage that throws never breaks the window ─────────────────────────────
globalThis.sessionStorage = { getItem () { throw new Error('denied'); }, setItem () { throw new Error('denied'); } };
eq(M.folderAskFor(bind), undefined, 'throwing storage: no ask');
M.forgetFolder(bind); ok(true, 'throwing storage: forget does not throw');
// ── a store that is not ours is ignored ─────────────────────────────────────
globalThis.sessionStorage = { getItem: () => '{"v":2,"entries":{"x":1}}', setItem () {} };
eq(M.readFolderRecord(bind), null, 'a foreign store shape is ignored');
globalThis.sessionStorage = { getItem: () => JSON.stringify({ v: 1, entries: { 'u1\nc1\n\n': { v: 1, kind: 'folder', path: '/workspace/../etc', at: 1 } } }), setItem () {} };
eq(M.folderAskFor(bind), undefined, 'a tampered record that is not a plain path is never asked');

console.log(`PASS ${checks} checks: code-folder (shared grammar, mint-id + nonce binding in both orderings, stale document, record rules, project child, notices, storage failures)`);
