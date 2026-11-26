// code-folder-test.mjs — EZiL-authored. Per-tab Code folder continuity, the shell side
// (`./code-folder.js`), against a fake iframe/window/sessionStorage/document:
//   - the shared path grammar (docs/contracts/code-folder-v1.vectors.json);
//   - the instance binding: mint id + per-hello nonce + origin + source + unchanged src,
//     in BOTH load orderings, and a stale earlier document dropped;
//   - the record rules (a transient miss never erases; Close Folder clears; multi-root
//     announced; a project child announced, never asked; an ask whose first document
//     opened anything else, or the asked folder after a definite non-restore, is always
//     said, once per mint);
//   - the managed checkout: a verified assignment preview says nothing about a bare project wrapper or its own
//     pair left in the shared record, and still says every folder opened by hand, every other binding and mint;
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
// A continued frame (the editor's own URL, no mint): its first report is the folder it was loaded at
// (no change, so no reload loop); later user-driven changes are heard and recorded.
follows.length = 0; F.src = DOC('/?folder=%2Fworkspace%2Fb');
M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind, notice, onUserFolder: (x) => follows.push(x), continued: true });
ok(F.sent.at(-1)?.m?.type === 'ezil.code.hello' && F.sent.at(-1).o === ORIGIN, 'continued: hello to the frame origin');
F.load(); reportB(null, 'folder', '/workspace/b', '/'); eq(follows, [], 'continued: its first document is no change');
eq(M.folderAskFor(bind), { v: 1, path: '/workspace/b' }, 'continued: the record follows the screen');
F.load(); reportB(null, 'folder', '/workspace/d', '/'); eq(follows, [{ url: DOC('/?folder=%2Fworkspace%2Fd') }], 'continued: a later Open Folder is heard');
F.load(); reportB(mintOf(url), 'folder', '/workspace/a', '/'); eq(M.folderAskFor(bind), { v: 1, path: '/workspace/d' }, 'continued: an earlier mint\'s document is dropped');
M.detachFolderBridge(F);

// 19 folder-url-sync: every counted report reaches onRoot (with the fallback flag), the editor's own switch is
//    asked for (ezil.code.open) and answered (ezil.code.go) only once this binding has heard from it, and leaving
//    is heard.
{
    M.forgetFolder(bind);
    const roots = []; const opens = []; let leaving = 0;
    const attachSync = (t, asked, answer) => {
        const u = M.tagFolderMint(minted(t), { asked, answer }); F.src = u;
        M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind, notice, onRoot: (r, how) => roots.push([r, how]), onOpen: (n) => opens.push(n), onLeaving: () => { leaving += 1; } });
        return u;
    };
    const ID = 'D'.repeat(22);
    url = attachSync('s1', { v: 1, path: '/workspace/a' }, { v: 1, outcome: 'restored' });
    fire({ type: 'ezil.code.open', v: 1, id: ID, kind: 'folder', path: '/workspace/b' });
    eq([opens.length, F.sent.filter(s => s.m.type === 'ezil.code.go').length], [0, 0], 'open before the first document reported: not answered');
    F.load(); reportB(mintOf(url), 'folder', '/workspace/a', '/preview/');
    eq(roots.at(-1), [{ kind: 'folder', path: '/workspace/a', base: '/preview/' }, { mintDriven: true, fallback: false }], 'the asked folder on screen: onRoot, no fallback');
    fire({ type: 'ezil.code.open', v: 1, id: ID, kind: 'folder', path: '/workspace/b' });
    eq(opens.at(-1), { kind: 'folder', path: '/workspace/b' }, 'the switch is heard before it happens');
    eq(F.sent.at(-1), { m: { type: 'ezil.code.go', v: 1, id: ID }, o: ORIGIN }, 'then answered with go, to the editor origin only');
    for ( const [d, ev, what] of [
        [{ type: 'ezil.code.open', v: 1, id: 'short', kind: 'folder', path: '/workspace/b' }, {}, 'a malformed id'],
        [{ type: 'ezil.code.open', v: 1, id: ID, kind: 'folder', path: '/workspace/b' }, { origin: 'https://evil.example' }, 'another origin'],
        [{ type: 'ezil.code.open', v: 1, id: ID, kind: 'folder', path: '/workspace/b' }, { source: {} }, 'another window'],
        [{ type: 'ezil.code.open', v: 2, id: ID, kind: 'folder', path: '/workspace/b' }, {}, 'another version'],
        [{ type: 'ezil.code.open', v: 1, id: ID, kind: 'mystery' }, {}, 'an unknown kind'],
    ] ) {
        const n = opens.length, s = F.sent.length;
        fire(d, ev);
        eq([opens.length, F.sent.length], [n, s], `open refused: ${what}`);
    }
    fire({ type: 'ezil.code.open', v: 1, id: ID, kind: 'workspace' }); eq(opens.at(-1), { kind: 'unsupported' }, 'a workspace switch: unsupported');
    fire({ type: 'ezil.code.open', v: 1, id: ID, kind: 'empty' }); eq(opens.at(-1), { kind: 'empty' }, 'Close Folder: empty');
    fire({ type: 'ezil.code.open', v: 1, id: ID, kind: 'folder', path: '/workspace/../etc' }); eq(opens.at(-1), { kind: 'unsupported' }, 'a path the grammar refuses: unsupported');
    fire({ type: 'ezil.code.leaving', v: 1 }); eq(leaving, 1, 'leaving is heard');
    fire({ type: 'ezil.code.leaving', v: 1 }, { origin: 'https://evil.example' }); eq(leaving, 1, 'leaving from another origin is not');
    F.load(); reportB(null, 'folder', '/workspace/b', '/preview/');
    eq(roots.at(-1), [{ kind: 'folder', path: '/workspace/b', base: '/preview/' }, { mintDriven: false, fallback: false }], 'the new document: onRoot, user-driven');
    F.load(); reportB(null, 'workspace', null, '/preview/');
    eq(roots.at(-1), [{ kind: 'unsupported' }, { mintDriven: false, fallback: false }], 'a workspace document: unsupported');
    M.detachFolderBridge(F);
    url = attachSync('s2', { v: 1, path: '/workspace/nope' }, { v: 1, outcome: 'missing' });
    F.load(); reportB(mintOf(url), 'folder', '/workspace', '/');
    eq(roots.at(-1), [{ kind: 'folder', path: '/workspace', base: '/' }, { mintDriven: true, fallback: true }], 'the default instead of the asked folder: onRoot with fallback');
    eq(notices.at(-1), ['missing', '/workspace/nope'], 'and the notice, as before');
    M.detachFolderBridge(F);
    M.forgetFolder(bind);
}

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
// folder-url-sync: a link's own folder the parser refused, and one beside a repository: said, Dismiss only.
for ( const code of ['link_invalid', 'with_repository'] ) {
    nb.fallback(code, null);
    eq(body.children.at(-1).attrs['data-outcome'], code, `${code}: its own outcome`);
    eq(body.children.at(-1).children.slice(1).map(b => b.textContent), ['Dismiss'], `${code}: Dismiss only`);
    ok(! /unsaved|come back/i.test(body.children.at(-1).children[0].textContent), `${code}: no recovery promise`);
}
nb.close(); ok(body.children.at(-1).removed, 'close');

// ── workbench readiness: asked only by a binding that wants it, answered only by this mint's mounted document ──
{
    F = frame();
    const P = { userId: 'u1', computerId: 'c-ready', project: { projectId: '11111111-1111-4111-8111-111111111111', repoId: '22222222-2222-4222-8222-222222222222' } };
    const ROOT = '/workspace/projects/22222222-2222-4222-8222-222222222222';
    const mounted = []; const roots = [];
    const attach = (extra = {}) => {
        F.src = M.tagFolderMint(minted('w1'), {});
        M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: P, notice, workbench: true,
            onRoot: (r, how) => roots.push([r, how]), onWorkbench: (r) => mounted.push(r), ...extra });
        return mintOf(F.src);
    };
    const helloNonce = () => F.sent.at(-1).m.nonce;
    const workbench = (mint, path, nonce = helloNonce(), more = {}, ev = {}) =>
        fire({ type: 'ezil.code.workbench', v: 1, nonce, mint, kind: 'folder', path, ...more }, ev);
    let id = attach();
    // the opt-in rides every hello, with the mint id the editor must match
    eq(F.sent.at(-1), { m: { type: 'ezil.code.hello', v: 1, nonce: helloNonce(), workbenchReady: true, mint: id }, o: ORIGIN }, 'the opted-in hello: workbenchReady + this mint, to the minted origin');
    // ahead of its hello's folder report: dropped (the echo names the document first)
    workbench(id, ROOT); eq(mounted, [], 'a workbench message before the folder report is dropped');
    report(id, 'folder', ROOT); const n1 = F.sent.at(-1).m.nonce;
    eq(roots.at(-1), [{ kind: 'folder', path: ROOT }, { mintDriven: true, fallback: false }], 'the folder echo still reaches onRoot');
    eq(mounted, [], 'the folder echo alone is never the workbench');
    // every refusal changes nothing and leaves the real answer acceptable
    workbench(id, ROOT, n1, {}, { origin: 'https://evil.example' });
    workbench(id, ROOT, n1, {}, { source: {} });
    workbench(id, ROOT, 'C'.repeat(22));
    workbench(id, ROOT, null);
    workbench(id, ROOT, n1, { v: 2 });
    workbench(null, ROOT, n1);
    workbench('D'.repeat(22), ROOT, n1);
    workbench(id, `${ROOT}/child`, n1);
    workbench(id, '/workspace/../etc', n1);
    workbench(id, undefined, n1);
    workbench(id, ROOT, n1, { kind: 'empty' });
    workbench(id, ROOT, n1, { kind: 'workspace' });
    eq(mounted, [], 'origin, source, nonce, version, mint, folder and kind refusals: nothing heard');
    workbench(id, `${ROOT}/`, n1);
    eq(mounted, [{ kind: 'folder', path: ROOT }], 'the mounted workbench of this mint, this hello and this folder is heard');
    workbench(id, ROOT, n1); workbench(id, ROOT, n1);
    eq(mounted.length, 1, 'once per hello: a repeat is dropped');
    // RE-ARM, same document: a new hello (the iframe load) forgets the one before it
    report(id, 'folder', ROOT, n1); eq(mounted.length, 1, 'a replayed folder report does not re-arm');
    F.load(); const n2 = helloNonce(); ok(n2 !== n1, 'a new hello, a new nonce');
    eq(F.sent.at(-1).m.workbenchReady, true, 'and it asks again');
    workbench(id, ROOT, n1); eq(mounted.length, 1, 'the earlier nonce is dropped after a new hello');
    workbench(id, ROOT, n2); eq(mounted.length, 1, 'the new nonce is dropped until its own folder report');
    report(id, 'folder', ROOT, n2);
    workbench(id, ROOT, n1); eq(mounted.length, 1, 'the earlier nonce stays dropped once the new hello is answered');
    workbench(id, ROOT, n2); eq(mounted.length, 2, 'the same mounted document answers the new hello again');
    // RE-ARM, a new document of the same mint (a reload in the frame): its ready makes a new hello; what the document
    // before it was told answers nothing, and only the new document's own mounted workbench counts
    F.load(); const n3 = helloNonce(); report(id, 'folder', ROOT, n3);
    fire({ type: 'ezil.code.ready', v: 1 }); const n4 = helloNonce(); ok(n4 !== n3, 'a new document: a new hello');
    workbench(id, ROOT, n3); eq(mounted.length, 2, 'the replaced document\'s armed nonce no longer answers');
    report(id, 'folder', ROOT, n4); eq(mounted.length, 2, 'the new document\'s echo: parked, no workbench yet');
    workbench(id, ROOT, n3); eq(mounted.length, 2, 'still not the earlier nonce');
    workbench(id, ROOT, n4); eq(mounted.length, 3, 'the new document\'s mounted workbench is heard');
    // a document that says it is leaving cannot answer afterwards
    F.load(); report(id, 'folder', ROOT); const n5 = helloNonce();
    fire({ type: 'ezil.code.leaving', v: 1 }); workbench(id, ROOT, n5);
    eq(mounted.length, 3, 'leaving disarms the hello');
    // a document the person navigated to (no mint) reports its folder but is never this mint's workbench
    F.load(); report(null, 'folder', ROOT); const n6 = helloNonce();
    eq(roots.at(-1)[1], { mintDriven: false, fallback: false }, 'the user-driven document is still heard as a root');
    workbench(null, ROOT, n6); workbench(id, ROOT, n6);
    eq(mounted.length, 3, 'a user-driven document never arms, whatever mint its message claims');
    // an empty or unsupported first document never arms
    for ( const kind of ['empty', 'workspace', 'foreign'] ) {
        F.load(); report(id, kind); workbench(id, ROOT); eq(mounted.length, 3, `${kind}: never armed`);
    }
    // a throwing listener is the window's own fault
    M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: P, notice, workbench: true, onWorkbench: () => { throw new Error('window bug'); } });
    eq(mounted.length, 3, 're-attached: the earlier binding hears nothing more');
    // replaced src: the stale binding drops the message and detaches
    id = attach(); report(id, 'folder', ROOT); const stale = helloNonce();
    F.src = M.tagFolderMint(minted('w2'), {}); workbench(id, ROOT, stale);
    eq(mounted.length, 3, 'a replaced frame URL: dropped'); eq(listeners.size, 0, 'and detached');
    // a fallback first document (the asked folder is not what opened) shows its notice and never arms
    F = frame(); store.clear();
    const own = { userId: 'u1', computerId: 'c-ready-own', project: null };
    F.src = M.tagFolderMint(minted('w3'), { asked: { v: 1, path: '/workspace/asked' }, answer: { v: 1, outcome: 'restored' } });
    M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: own, notice, workbench: true, onWorkbench: (r) => mounted.push(r) });
    report(mintOf(F.src), 'folder', '/workspace'); eq(notices.at(-1), ['not_reopened', '/workspace/asked'], 'the fallback is said');
    workbench(mintOf(F.src), '/workspace'); workbench(mintOf(F.src), '/workspace/asked');
    eq(mounted.length, 3, 'a fallback document never arms');
    // LEGACY: a binding that did not ask sends no opt-in and hears nothing, whatever arrives
    for ( const off of [undefined, false, 'true', 1] ) {
        F = frame(); F.src = M.tagFolderMint(minted('w4'), {});
        M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: P, notice, ...(off === undefined ? {} : { workbench: off }), onWorkbench: (r) => mounted.push(r) });
        eq(Object.keys(F.sent.at(-1).m).sort(), ['nonce', 'type', 'v'], `workbench ${String(off)}: the hello is the ordinary one, byte for byte`);
        report(mintOf(F.src), 'folder', ROOT); workbench(mintOf(F.src), ROOT, F.sent.at(-1).m.nonce);
        eq(mounted.length, 3, `workbench ${String(off)}: nothing heard`);
    }
    // the repository presentation hint keeps its own fields beside the opt-in
    F = frame(); F.src = M.tagFolderMint(minted('w5'), { repositoryFocus: { folder: ROOT, name: 'default/qa' } });
    M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: P, notice, workbench: true });
    eq(F.sent.at(-1).m, { type: 'ezil.code.hello', v: 1, nonce: helloNonce(), workbenchReady: true, mint: mintOf(F.src), repositoryFocus: { folder: ROOT, name: 'default/qa' } }, 'opt-in and presentation hint together');
    // a frame with no mint (a continued editor document) has no first document to ask
    F = frame(); F.src = `${ORIGIN}/?folder=${encodeURIComponent(ROOT)}`;
    M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: P, notice, workbench: true, continued: true, onWorkbench: (r) => mounted.push(r) });
    eq(Object.keys(F.sent.at(-1).m).sort(), ['nonce', 'type', 'v'], 'continued: never asks');
    report(null, 'folder', ROOT); workbench(null, ROOT); eq(mounted.length, 3, 'continued: nothing heard');
    M.detachFolderBridge(F);
}

// ── managed checkout: a leftover of the shared record is not a folder opened by hand ────────────────────────
{
    // A repository opened from its address has no ids: its record is the one its owner and computer share.
    const A = '2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
    const R = { userId: 'u1', computerId: 'c-managed', project: { repoUrl: `https://github.ezil.work/default/u-0482ba160482ba16-a-${A}.git` } };
    const own = { userId: 'u1', computerId: 'c-managed', project: null };
    const WS = '/workspace/projects/12222222-3333-4444-8555-666666666666', CO = `${WS}/u-0482ba160482ba16-a-${A}`;
    const OTHER = '/workspace/projects/0aaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const PAIR = { workspaceFolder: WS, checkoutFolder: CO };
    const mounted = []; const roots = [];
    // One mint of the verified preview: `prev` is what the shared record held, `shown` what its first document reports.
    const open = (prev, shown, o = {}) => {
        const has = (k) => Object.hasOwn(o, k), checkout = has('checkout') ? o.checkout : PAIR, workbench = has('workbench') ? o.workbench : true;
        notices.length = 0; roots.length = 0;
        F = frame(); M.forgetFolder(R);
        if ( prev ) { F.src = M.tagFolderMint(minted('m0'), {}); M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: own, notice }); report(mintOf(F.src), 'folder', prev); }
        eq(M.readFolderRecord(R)?.path ?? null, prev, 'the repository reads the shared record');
        F.src = M.tagFolderMint(minted('m1'), { checkout });
        M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: R, notice, ...(workbench === undefined ? {} : { workbench }),
            onRoot: (r, how) => roots.push([r, how]), onWorkbench: (r) => mounted.push(r) });
        report(has('mint') ? o.mint : mintOf(F.src), 'folder', shown);
        return notices.slice();
    };
    const SAID = (prev) => [['child', prev]];
    // the reported case: the record is a bare project wrapper, the verified workbench opened the server's folder
    eq(open(OTHER, WS), [], 'another bare wrapper, then the verified workspace folder: nothing is said');
    eq(M.readFolderRecord(R)?.path, WS, 'the record still follows the screen');
    eq(roots, [[{ kind: 'folder', path: WS }, { mintDriven: true, fallback: false }]], 'the root is heard as before');
    fire({ type: 'ezil.code.workbench', v: 1, nonce: F.sent.at(-1).m.nonce, mint: mintOf(F.src), kind: 'folder', path: WS });
    eq(mounted, [{ kind: 'folder', path: WS }], 'and its mounted workbench still answers');
    eq(open(OTHER, CO), [], 'another bare wrapper, then the verified checkout: nothing is said');
    eq(open(CO, WS), [], 'the exact checkout, then its workspace folder: nothing is said');
    eq(open(WS, CO), [], 'the exact workspace folder, then its checkout: nothing is said');
    eq(open(WS, WS), [], 'the same folder: nothing was ever said');
    eq(open(null, WS), [], 'no record: nothing to say');
    // a folder opened by hand is still said: below the checkout, below the wrapper, below another wrapper
    for ( const prev of [`${CO}/src`, `${WS}/other`, `${OTHER}/repository`, `${OTHER}/repository/web`] ) {
        eq(open(prev, WS), SAID(prev), `${prev}: a deeper folder is still said`);
        eq(M.readFolderRecord(R)?.path, WS, 'and the record follows the screen as before');
    }
    // an ordinary folder, and anything that only looks like a wrapper
    for ( const prev of ['/workspace', '/workspace/sports/sports-web', '/workspace/projects', '/workspace/projects/my-site',
        '/workspace/projects/0AAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE', `/home/user${OTHER}`, `${OTHER}x`] ) {
        eq(open(prev, WS), SAID(prev), `${prev}: not a bare wrapper, still said`);
    }
    // the verified pair is the only thing that silences: a first document on any other folder is said
    for ( const shown of [OTHER, `${CO}/src`, '/workspace', `${WS}x`] ) eq(open(WS, shown), SAID(WS), `${shown}: not the verified pair, said`);
    eq(open(OTHER, `${CO}/src`), SAID(OTHER), 'a bare wrapper is said too when the document is not the verified pair');
    // only the signed preparation's binding, and only with the server's pair on this very mint
    for ( const workbench of [undefined, false, 1, 'true'] ) eq(open(OTHER, WS, { workbench }), SAID(OTHER), `workbench ${String(workbench)}: said as before`);
    for ( const checkout of [undefined, null, {}, 'x', { workspaceFolder: WS }, { checkoutFolder: CO }, { workspaceFolder: CO, checkoutFolder: WS },
        { workspaceFolder: WS, checkoutFolder: WS }, { workspaceFolder: WS, checkoutFolder: `${CO}/src` }, { workspaceFolder: WS, checkoutFolder: `${WS}x/repo` },
        { workspaceFolder: `${WS}/`, checkoutFolder: CO }, { workspaceFolder: WS, checkoutFolder: `${CO}/` }, { workspaceFolder: WS, checkoutFolder: `${WS}/../x` },
        { workspaceFolder: '/', checkoutFolder: '/x' }, { workspaceFolder: 'workspace', checkoutFolder: 'workspace/x' }, { workspaceFolder: 7, checkoutFolder: CO }, { workspaceFolder: null, checkoutFolder: null }, { workspaceFolder: WS, checkoutFolder: null },
        { workspaceFolder: null, checkoutFolder: CO }, { workspaceFolder: '', checkoutFolder: '' }] ) {
        eq(open(OTHER, WS, { checkout }), SAID(OTHER), `no well-formed pair (${JSON.stringify(checkout)}): said as before`);
    }
    // a document that is not this mint's first is never the one that decides (dropped: no notice, no record)
    eq(open(OTHER, WS, { mint: 'D'.repeat(22) }), [], 'another mint\'s document says nothing'); eq(M.readFolderRecord(R)?.path, OTHER, 'and writes nothing');
    eq(open(OTHER, WS, { mint: null }), [], 'a document before the first report says nothing'); eq(M.readFolderRecord(R)?.path, OTHER, 'and writes nothing');
    // the pair is read once, by its own mint: the next mint without it says the record again
    open(OTHER, WS); M.forgetFolder(R);
    F = frame(); F.src = M.tagFolderMint(minted('m2'), {}); M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: own, notice }); report(mintOf(F.src), 'folder', OTHER);
    F.src = M.tagFolderMint(minted('m3'), {}); M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: R, notice, workbench: true });
    notices.length = 0; report(mintOf(F.src), 'folder', WS); eq(notices, SAID(OTHER), 'a later mint without the pair is said as before');
    // a project with ids keeps its own record and its own rule (r32), pair or no pair
    const P = { userId: 'u1', computerId: 'c-managed', project: { projectId: '11111111-1111-4111-8111-111111111111', repoId: '12222222-3333-4444-8555-666666666666' } };
    F = frame(); F.src = M.tagFolderMint(minted('m4'), {}); M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: P, notice }); report(mintOf(F.src), 'folder', WS);
    F.load(); report(null, 'folder', `${WS}/web`);
    F.src = M.tagFolderMint(minted('m5'), { checkout: PAIR }); M.attachFolderBridge({ iframe: F, frameUrl: F.src, bind: P, notice, workbench: true });
    notices.length = 0; report(mintOf(F.src), 'folder', WS); eq(notices, SAID(`${WS}/web`), 'a project child opened by hand is still said');
    M.detachFolderBridge(F); M.forgetFolder(R); M.forgetFolder(P); notices.length = 0;
}

// ── storage that throws never breaks the window ─────────────────────────────
globalThis.sessionStorage = { getItem () { throw new Error('denied'); }, setItem () { throw new Error('denied'); } };
eq(M.folderAskFor(bind), undefined, 'throwing storage: no ask');
M.forgetFolder(bind); ok(true, 'throwing storage: forget does not throw');
// ── a store that is not ours is ignored ─────────────────────────────────────
globalThis.sessionStorage = { getItem: () => '{"v":2,"entries":{"x":1}}', setItem () {} };
eq(M.readFolderRecord(bind), null, 'a foreign store shape is ignored');
globalThis.sessionStorage = { getItem: () => JSON.stringify({ v: 1, entries: { 'u1\nc1\n\n': { v: 1, kind: 'folder', path: '/workspace/../etc', at: 1 } } }), setItem () {} };
eq(M.folderAskFor(bind), undefined, 'a tampered record that is not a plain path is never asked');

console.log(`PASS ${checks} checks: code-folder (shared grammar, mint-id + nonce binding in both orderings, stale document, record rules, project child, notices, workbench readiness, managed checkout, storage failures)`);
