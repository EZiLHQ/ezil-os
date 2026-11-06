// code-folder.js — EZiL-authored. Per-tab folder continuity for the Code window.
//
// What it does, and nothing more:
//   1. Keeps ONE record per (user, computer, project?, repo?) in THIS TAB's
//      sessionStorage: the folder the bound editor last reported. The record is
//      never a URL key and never shared with another tab. (Since folder-url-sync
//      the ADDRESS may name a folder too, `/app/code?folder=`, which the mint asks
//      for before this record; either way the server's walk decides what opens.)
//   2. Gives the mint the record of an own-files tab (`folderAskFor`). A project
//      tab asks nothing: the server fixes its root to the repository folder
//      (r32; a project's `path` is reveal-only).
//   3. Binds the editor in the iframe to THIS mint (`attachFolderBridge`):
//      origin + source + unchanged frame URL + per-hello nonce + the mint id
//      (`ezil_mint`) that rides the bootstrap URL into the mint's FIRST
//      document only (code-server's own redirect keeps it; VS Code's Open
//      Folder drops it).
//   4. Shows a visible notice whenever a mint that asked for a folder did not
//      open exactly that folder in its first document (another folder, an
//      empty window, a workspace, a foreign or unreadable folder), or did but
//      the server found that folder missing or not a directory, and keeps the record so
//      the next mint asks again (a transient miss never erases it; only Close
//      Folder, a new folder or "Forget it" do).
//
// The editor's report is a HINT. Authority is the next mint's server-side
// resolution: the Worker strips the computer's own root and walks the rest on
// the computer with no symlink followed (worker/src/code-folder.ts). The editor
// side is injected by the Worker into code-server's workbench document, on both
// computers (worker/src/code-folder-bridge.ts); an editor without it never
// reports, so this module then does nothing at all.
//
// Folder URL sync (folder-url-sync, 2026-11-05): the window also hears every
// report (`onRoot`), and the editor's own folder switches before they happen
// (`ezil.code.open` → `onOpen`, then `ezil.code.go` back), so the Code window
// can keep `/app/code?folder=` on the address bar and give each switch its own
// history entry (docs/APP-ROUTES.md §5 "Code's folder").
//
// Why sessionStorage and not history.state: Code is single-instance per tab,
// the folder belongs to the window rather than to a history entry,
// Back/Forward never re-mints an open window (app-history.js), and a Code
// window closed and reopened in the same tab should come back to its folder.
// The store is reached only through readStore/writeStore below.
//
// Same path grammar as the app and Worker: docs/contracts/code-folder-v1.vectors.json.

const STORE_KEY = 'ezil-os:code.folder.v1';
/** The per-mint instance id on the iframe URL. Never an app-link key (app-link.js KEYS), never authority. */
export const MINT_PARAM = 'ezil_mint';
const MAX_RECORDS = 32;
const MAX_PATH_BYTES = 2048;
const MAX_SEGMENT_BYTES = 255;
const MAX_SEGMENTS = 64;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const OUTCOME_RE = /^[a-z_]{1,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Server outcomes that opened something other than the asked folder (codes only; never a path). */
const FALLBACKS = new Set(['missing', 'not_directory', 'symlink', 'outside', 'not_allowed', 'invalid', 'unverified', 'too_long', 'error']);
/**
 * Server outcomes that say the asked folder cannot be open: no `folder=` was added, so the editor opened its own last
 * folder, which may be the asked one itself, and then shows only VS Code's own "does not exist". Every other outcome
 * with a matching report means that last folder exists and is on screen (`symlink`, `too_long`, a policy refusal,
 * `unverified`, no answer), so it stays silent like `restored`.
 */
const NOT_RESTORED = new Set(['missing', 'not_directory']);

/**
 * The notice code for a mint that asked for a folder and whose first document opened something else. Shell-local
 * codes, never on the wire: `not_reopened` when the server said `restored` (the editor still opened another thing),
 * `unsupported_server` when the server answered no code it knows (an older Worker or app ignored the ask).
 */
function fallbackCode (outcome) {
    if ( FALLBACKS.has(outcome) ) return outcome;
    return outcome === 'restored' ? 'not_reopened' : 'unsupported_server';
}

const utf8 = (s) => new TextEncoder().encode(s).length;

/** No lone surrogate (the same check the app and Worker make). */
function wellFormed (s) {
    for ( let i = 0; i < s.length; i += 1 ) {
        const c = s.charCodeAt(i);
        if ( c >= 0xd800 && c <= 0xdbff ) {
            const n = s.charCodeAt(i + 1);
            if ( ! (n >= 0xdc00 && n <= 0xdfff) ) return false;
            i += 1;
        } else if ( c >= 0xdc00 && c <= 0xdfff ) {
            return false;
        }
    }
    return true;
}

/**
 * The plain absolute folder path an editor may report, normalised (one trailing
 * `/` dropped), or null. Spaces and any well-formed Unicode are kept as they are
 * (no NFC: a file name is bytes).
 */
export function plainFolderPath (value) {
    if ( typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_BYTES ) return null;
    if ( ! wellFormed(value) ) return null;
    const path = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
    if ( ! path.startsWith('/') || utf8(path) > MAX_PATH_BYTES ) return null;
    for ( let i = 0; i < path.length; i += 1 ) {
        const c = path.charCodeAt(i);
        if ( c < 0x20 || c === 0x7f || c === 0x5c ) return null;
    }
    if ( path === '/' ) return path;
    const segments = path.slice(1).split('/');
    if ( segments.length > MAX_SEGMENTS ) return null;
    for ( const s of segments ) {
        if ( s === '' || s === '.' || s === '..' || utf8(s) > MAX_SEGMENT_BYTES ) return null;
    }
    return path;
}

function recordKey ({ userId, computerId, project } = {}) {
    if ( typeof userId !== 'string' || userId === '' || typeof computerId !== 'string' || computerId === '' ) return null;
    const p = project && UUID.test(project.projectId ?? '') && UUID.test(project.repoId ?? '') ? project : null;
    return [userId, computerId, p?.projectId ?? '', p?.repoId ?? ''].join('\n');
}

function readStore () {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(STORE_KEY) ?? '{}');
        return parsed && typeof parsed === 'object' && parsed.v === 1 && parsed.entries && typeof parsed.entries === 'object'
            ? parsed : { v: 1, entries: {} };
    } catch {
        return { v: 1, entries: {} };
    }
}

function writeStore (store) {
    const keys = Object.keys(store.entries).sort((a, b) => (store.entries[b]?.at ?? 0) - (store.entries[a]?.at ?? 0));
    for ( const k of keys.slice(MAX_RECORDS) ) delete store.entries[k];
    try { sessionStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* no continuity in this tab, no failure */ }
}

/** This tab's record for `bind`, or null. A record that no longer parses is ignored, never trusted. */
export function readFolderRecord (bind) {
    const key = recordKey(bind);
    if ( ! key ) return null;
    const rec = readStore().entries[key];
    if ( ! rec || rec.v !== 1 ) return null;
    if ( rec.kind === 'folder' ) return plainFolderPath(rec.path) ? rec : null;
    return rec.kind === 'unsupported' ? rec : null;
}

function putFolderRecord (bind, rec) {
    const key = recordKey(bind);
    if ( ! key ) return;
    const store = readStore();
    if ( rec ) store.entries[key] = { v: 1, ...rec, at: Date.now() }; else delete store.entries[key];
    writeStore(store);
}

/** Forget this tab's folder for `bind` (the notice's "Forget it"). */
export function forgetFolder (bind) { putFolderRecord(bind, null); }

/**
 * The mint body's `codeFolder`, or undefined. Own-files tabs only. Omitted
 * entirely, never defaulted, so a tab with no record gets today's per-provider
 * default byte for byte.
 */
export function folderAskFor (bind) {
    if ( ! bind || bind.project ) return undefined;
    const rec = readFolderRecord(bind);
    return rec?.kind === 'folder' ? { v: 1, path: rec.path } : undefined;
}

function token () {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// mint id -> what was asked and what the server answered (codes only). Read
// once, by the binding of that mint; bounded.
const mints = new Map();

/**
 * Tag a successful mint: the URL to put in the iframe (the minted one plus
 * `ezil_mint=<id>`), remembering what was asked and answered for it. A server
 * that answered no outcome to an ask is an older one (`unsupported_server`).
 */
export function tagFolderMint (url, { asked, answer } = {}) {
    const id = token();
    const outcome = typeof answer?.outcome === 'string' && OUTCOME_RE.test(answer.outcome) ? answer.outcome : null;
    mints.set(id, { asked: asked?.path ?? null, outcome: asked && ! outcome ? 'unsupported_server' : outcome });
    while ( mints.size > 8 ) mints.delete(mints.keys().next().value);
    try {
        const u = new URL(url);
        // Appended as text, so the minted URL stays byte for byte a prefix of what the iframe gets (a re-serialised
        // query would re-encode the token and the folder, and grow toward the 2048-character frame-confirm cap).
        if ( ! u.hash && ! u.searchParams.has(MINT_PARAM) ) {
            return `${url}${u.search ? '&' : url.endsWith('?') ? '' : '?'}${MINT_PARAM}=${id}`;
        }
        u.searchParams.set(MINT_PARAM, id);
        return u.toString();
    } catch {
        return url;
    }
}

// The editor's own document path (`location.pathname`), as its bridge reports it: `/` on AWS, `/preview/` on
// Cloudflare. Only plain directory paths; never a host, a query or a dot segment.
const BASE_RE = /^\/(?:[A-Za-z0-9_-]{1,32}\/){0,4}$/;

/**
 * The editor document URL for a folder (or the empty window) the editor itself just opened in the frame: the
 * frame's origin, the document path the editor reported, and `folder=` (or `ew=true`). Null for anything else.
 * Only ever the editor's own navigation, never a minted (token) URL, and never authority over what is opened.
 */
export function editorDocumentUrl (frameUrl, report) {
    if ( ! report || typeof report.base !== 'string' || ! BASE_RE.test(report.base) ) return null;
    let u;
    try { u = new URL(report.base, new URL(frameUrl).origin); } catch { return null; }
    if ( report.kind === 'folder' ) {
        const path = plainFolderPath(report.path);
        if ( ! path ) return null;
        u.searchParams.set('folder', path);
    } else if ( report.kind === 'empty' ) {
        u.searchParams.set('ew', 'true');
    } else {
        return null;
    }
    return u.href;
}

const bridges = new WeakMap();

/** Stop listening for `iframe`'s editor (the window closed). */
export function detachFolderBridge (iframe) { bridges.get(iframe)?.detach(); }

/**
 * Bind the editor in `iframe` to the mint whose URL is `frameUrl` (the iframe's
 * `src` PROPERTY, as `settle_frame` reads it). Called from `settle_frame`'s
 * confirmed branch only, so a local editor never binds.
 *
 * A report counts only if `ev.source === iframe.contentWindow`, `ev.origin` is
 * the minted origin, `iframe.src` is still `frameUrl`, and `nonce` is the one of
 * the latest hello. Then:
 *   - `mint === <this mint's id>`: the mint's FIRST document (mint-driven), in
 *     whichever order load and the server's confirmation came;
 *   - `mint === null`, after that first document reported: a document the
 *     person navigated to inside the frame (user-driven);
 *   - anything else (a stale document of an earlier mint, a first document
 *     that has not reported yet): dropped without a word.
 * A mint-driven report that is not exactly the asked folder, or is but the
 * server found it missing or not a directory, shows the notice once for this
 * binding and leaves the record as it was.
 *
 * `continued`: `frameUrl` is the editor's own document URL in a frame that has
 * no mint: its documents are all user-driven. `onUserFolder` hears each
 * user-driven folder or empty window that differs from the last one reported,
 * with the URL of that document (`editorDocumentUrl`, null if the editor did not
 * say its document path).
 *
 * Folder URL sync:
 *   - `onRoot(root, {mintDriven, fallback})` hears every report that counts, with
 *     what the editor shows: `{kind: 'folder', path, base?}`, `{kind: 'empty', base?}`
 *     or `{kind: 'unsupported'}` (a workspace, another scheme, a path the grammar
 *     refuses). `fallback` is the mint-driven report that is NOT the asked folder
 *     (the notice is shown; the address should keep what was asked).
 *   - `onOpen(next)` hears the editor's own folder switch BEFORE it happens
 *     (`ezil.code.open`, same `next` shapes), once the first document has
 *     reported; this module then answers `ezil.code.go` so the editor replaces its
 *     document. A request before that, or with a malformed id, is not answered:
 *     the editor switches by itself after its own fallback delay.
 *   - `onLeaving()` hears that the editor's document is about to be navigated away
 *     (`ezil.code.leaving`, its beforeunload): a navigation is under way, so the
 *     window must not start one of its own.
 *
 * 🔴 Nothing here may tear the editor down by itself. Chrome keeps a frame's
 * document per joint history entry; F2 (Back after an in-frame Open Folder
 * reloaded the editor at the mint's first folder) is closed by folder-url-sync
 * WITHOUT any teardown: each switch made in Code gets its own entry before the
 * editor replaces its document in it (`onOpen` / `ezil.code.go`), so the
 * browser's own per-entry reload is the right folder. Removing a live frame
 * would skip its `beforeunload`, i.e. code-server's "pending backups" veto, and
 * can lose unsaved edits (independent review, 3 Nov 2026); no shell code may do
 * that until the editor can confirm its backups are durable and editing has
 * stopped. A delay or a generic ready message is not that confirmation.
 */
export function attachFolderBridge ({ iframe, frameUrl, bind, notice, onUserFolder, onRoot, onOpen, onLeaving, continued = false }) {
    bridges.get(iframe)?.detach();
    let origin, mintId;
    try {
        const u = new URL(frameUrl);
        origin = u.origin;
        mintId = continued ? null : u.searchParams.get(MINT_PARAM);
    } catch { return () => {}; }
    if ( ! continued && ! TOKEN_RE.test(mintId ?? '') ) return () => {};
    const mint = (mintId && mints.get(mintId)) || { asked: null, outcome: null };
    if ( mintId ) mints.delete(mintId);
    let nonce = null;
    let firstSeen = continued;
    let last = null; // the last folder/empty report, so onUserFolder hears changes only
    let fallbackShown = false; // the first document answers each hello (attach, ready, load): one notice per mint
    const live = () => iframe.isConnected && iframe.src === frameUrl;
    const hello = () => {
        if ( ! live() ) { detach(); return; }
        nonce = token();
        try { iframe.contentWindow?.postMessage({ type: 'ezil.code.hello', v: 1, nonce }, origin); } catch { /* gone */ }
    };
    // What a report or an open request says the editor shows (or will): a plain folder, the empty window, or
    // anything Code cannot name in an address (a workspace, another scheme, a path the grammar refuses).
    const rootOf = (d) => {
        const base = typeof d.base === 'string' ? { base: d.base } : {};
        if ( d.kind === 'folder' ) {
            const path = plainFolderPath(d.path);
            return path ? { kind: 'folder', path, ...base } : { kind: 'unsupported' };
        }
        if ( d.kind === 'empty' ) return { kind: 'empty', ...base };
        return d.kind === 'workspace' || d.kind === 'foreign' ? { kind: 'unsupported' } : null;
    };
    const heard = (root, how) => { if ( root ) { try { onRoot?.(root, how); } catch { /* the window's own fault, never the bridge's */ } } };
    const onMessage = (ev) => {
        if ( ev.source !== iframe.contentWindow || ev.origin !== origin ) return;
        if ( ! live() ) { detach(); return; }
        const d = ev.data;
        if ( ! d || typeof d !== 'object' || d.v !== 1 ) return;
        if ( d.type === 'ezil.code.ready' ) { hello(); return; }
        if ( d.type === 'ezil.code.leaving' ) { try { onLeaving?.(); } catch { /* as above */ } return; }
        if ( d.type === 'ezil.code.open' ) {
            // The editor is about to switch folder in this frame. Only a document this binding has heard from may
            // ask (a stale one of an earlier mint is about to be replaced anyway): the window adds the entry, then
            // the editor is told to go.
            const next = rootOf(d);
            if ( ! firstSeen || ! TOKEN_RE.test(d.id ?? '') || ! next ) return;
            try { onOpen?.(next); } catch { /* the editor still switches */ }
            try { iframe.contentWindow?.postMessage({ type: 'ezil.code.go', v: 1, id: d.id }, origin); } catch { /* gone */ }
            return;
        }
        if ( d.type !== 'ezil.code.folder' || ! TOKEN_RE.test(d.nonce ?? '') || d.nonce !== nonce ) return;
        nonce = null; // one report per hello
        const mintDriven = mintId !== null && d.mint === mintId;
        if ( ! mintDriven && ! (d.mint === null && firstSeen) ) return;
        firstSeen = true;
        if ( mintDriven && mint.asked
            && (! (d.kind === 'folder' && plainFolderPath(d.path) === mint.asked) || NOT_RESTORED.has(mint.outcome)) ) {
            // The mint asked for a folder and its first document opened anything else: another folder, an empty
            // window, a workspace, a folder of another host or one the grammar refuses. The editor's provider fixes
            // this document's workspace synchronously from its URL at startup, so this is the final answer for the
            // mint, not a "not hydrated yet". Or it reported exactly that folder although the server found it missing
            // or not a directory: with no `folder=` the editor opened its own last folder, the asked one, and shows
            // only VS Code's own "does not exist". Any other outcome with a matching report has that folder on
            // screen (the editor's own pick) and stays silent below. Say so
            // (visible), and keep the record untouched so the next mint asks again (a missing mount that comes back,
            // an older server that ignored the ask). Never erased here.
            if ( ! fallbackShown ) {
                fallbackShown = true;
                notice?.fallback?.(fallbackCode(mint.outcome), mint.asked);
            }
            heard(rootOf(d), { mintDriven, fallback: true });
            return;
        }
        if ( d.kind === 'folder' ) {
            const path = plainFolderPath(d.path);
            if ( ! path ) { putFolderRecord(bind, { kind: 'unsupported', reason: 'path' }); heard({ kind: 'unsupported' }, { mintDriven, fallback: false }); return; }
            if ( mintDriven && bind.project ) {
                // r32: a project reopens at its repository folder; a child opened by hand is not reopened as the
                // root (the repository's own config stays inert). Say so once, then follow what is on screen.
                const prev = readFolderRecord(bind);
                if ( prev?.kind === 'folder' && prev.path !== path ) notice?.projectChild?.(prev.path);
            }
            putFolderRecord(bind, { kind: 'folder', path });
            changed(mintDriven, `folder:${path}`, { kind: 'folder', path, base: d.base });
        } else if ( d.kind === 'empty' ) {
            if ( ! mintDriven ) putFolderRecord(bind, null); // Close Folder: the tab has no folder now
            changed(mintDriven, 'empty', { kind: 'empty', base: d.base });
        } else if ( d.kind === 'workspace' || d.kind === 'foreign' ) {
            if ( ! mintDriven ) putFolderRecord(bind, { kind: 'unsupported', reason: d.kind });
        }
        heard(rootOf(d), { mintDriven, fallback: false });
    };
    // A user-driven document that changed what the frame shows: the shell may reload it in a fresh frame (F2).
    const changed = (mintDriven, key, report) => {
        const moved = last !== null && last !== key;
        last = key;
        if ( ! mintDriven && moved ) onUserFolder?.({ url: editorDocumentUrl(frameUrl, report) });
    };
    const detach = () => {
        iframe.removeEventListener('load', hello);
        window.removeEventListener('message', onMessage);
        if ( bridges.get(iframe)?.detach === detach ) bridges.delete(iframe);
    };
    iframe.addEventListener('load', hello);
    window.addEventListener('message', onMessage);
    bridges.set(iframe, { detach });
    if ( readFolderRecord(bind)?.kind === 'unsupported' ) { notice?.fallback?.('unsupported', null); forgetFolder(bind); }
    hello();
    return detach;
}

// ── the notice (visible, recoverable; text only, never markup) ─────────────
const COPY = {
    // No copy promises that unsaved changes come back: code-server keeps its hot-exit backups in its user-data
    // directory, which a Cloudflare container recreates on every start. "Nothing was deleted" is what is known.
    missing: (n) => `Couldn't reopen “${n}”: it isn't on this computer right now. Nothing was deleted.`,
    not_directory: (n) => `Couldn't reopen “${n}”: it isn't a folder right now. Nothing was deleted.`,
    symlink: (n) => `“${n}” is reached through a link. Code reopens real folders inside your workspace only. Open it from File > Open Recent.`,
    outside: (n) => `“${n}” is outside your workspace, so it isn't reopened automatically. Open it from File > Open Recent.`,
    not_allowed: (n) => `“${n}” belongs to a project or to EZiL. Open the project to work there.`,
    too_long: (n) => `“${n}” is too deep to reopen automatically. Open it from File > Open Recent.`,
    unverified: (n) => `Code couldn't check “${n}” on this computer yet, so it opened its usual folder.`,
    not_reopened: (n) => `Code didn't reopen “${n}” this time, so it opened its usual folder. Nothing was deleted.`,
    unsupported: () => 'Code reopens single folders only; your workspace is still in File > Open Recent.',
    child: (n) => `This project reopened at its folder. “${n}” isn't reopened automatically, so the repository's own settings stay off. Open it from File > Open Recent.`,
    // A link's own `folder` the address-bar parser refused (`../app-link.js` parseFolder): nothing was asked for.
    link_invalid: () => "This link's folder isn't a folder Code can open, so Code opened its usual folder.",
    // A folder beside a project or repository (docs/APP-ROUTES.md §2): the folder is dropped and nothing project-wise
    // opens here, so the mint asks for the tab's own folder, else the default: Code's usual folder.
    with_repository: () => "A link can't name a folder beside a project, so Code opened its usual folder. Open the folder from File > Open Recent.",
};
COPY.invalid = COPY.unsupported;
// Not `unverified`: the server cannot check folders yet (no resolver wired), so a re-mint gets the same answer.
const RETRYABLE = new Set(['missing', 'not_directory', 'error', 'unsupported_server', 'not_reopened']);

/**
 * The notice band for one Code window: `role=status`, text only. `retry`
 * re-mints (`start_boot`); `forget` drops the tab's record. Styles live in
 * `ezil-shell.css` (`.ezil-code-folder-notice`), never inline.
 */
export function createFolderNotice (el_body, { retry, forget } = {}) {
    let el = null;
    const close = () => { el?.remove(); el = null; };
    const show = (code, path) => {
        close();
        const name = path ?? '';
        const text = (COPY[code] ?? COPY.unverified)(name.length > 120 ? `…${name.slice(-119)}` : name);
        el = document.createElement('div');
        el.className = 'ezil-code-folder-notice';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        el.setAttribute('data-outcome', code);
        const msg = document.createElement('span');
        msg.className = 'ezil-code-folder-notice-text';
        msg.textContent = text;
        el.appendChild(msg);
        const button = (label, fn) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'ezil-code-folder-notice-action';
            b.textContent = label;
            b.addEventListener('click', () => { close(); fn?.(); });
            el.appendChild(b);
        };
        if ( RETRYABLE.has(code) && retry ) button('Try again', retry);
        if ( path && forget && code !== 'child' ) button('Forget it', forget);
        button('Dismiss', null);
        el_body.appendChild(el);
    };
    return { fallback: (code, path) => show(code, path), projectChild: (path) => show('child', path), close };
}
