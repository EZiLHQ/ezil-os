// Explicit shell entry intent. Browser's internal app id remains `desktop`;
// its address is `/app/browser` (`routeName`).
// Two spellings reach the same app: the canonical path form `/app/<id>?…` and
// the older query alias `/os?app=<id>` / `/os?settings=<tab>` (app-history.js
// rewrites the alias to the path form). See docs/APP-ROUTES.md.
// Project parameters are PARSED here and nothing more: no arbitrary URL is
// used as an iframe target, and a ref, account id or token in the URL is never
// read. A repository ADDRESS (`/app/code?repo=<URL-encoded https URL>`,
// founder 547ed35a) is read as navigation intent only: shape-checked here,
// canonicalised and authorised by the server, never fetched or framed.
// Code's FOLDER (`/app/code?folder=<path>`, folder-url-sync 2026-11-05) is read
// as navigation intent only too: normalised lexically here, then walked on the
// computer by the server before anything opens (worker/src/code-folder.ts). A
// folder the walk refuses never opens because a URL named it.
export const ALIASES = Object.freeze({ browser: 'desktop' });
export const SECTIONS = new Set(['account', 'usage', 'billing', 'computers', 'system', 'appearance', 'about', 'troubleshoot']);
// Every key this parser reads. A repeated one makes the whole link ambiguous.
const KEYS = ['app', 'settings', 'tab', 'project', 'repo', 'path', 'folder'];
/** What a relative `folder` is relative to: the workspace root of every computer (Cloudflare mount, AWS). */
export const FOLDER_ROOT = '/workspace';
const FOLDER_MAX_BYTES = 2048;
const FOLDER_MAX_SEGMENTS = 64;
const FOLDER_MAX_SEGMENT_BYTES = 255;
const APP_PATH = /^\/app\/([a-z0-9-]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const PATH_MAX_BYTES = 255;
/** A repository address: https, no whitespace, query, fragment, userinfo, backslash or escape (the server decides the rest). */
const REPO_URL = /^https:\/\/[^\s?#@\\%]{1,500}$/;
// `ALIASES` read backwards: the address an app is written at, where it is not
// its registry id. The Browser's id stays `desktop` (DOM and wire plumbing),
// but the address bar, and so every link copied from it, says `/app/browser`.
// `/app/desktop` still opens the Browser; the boot rewrites it in place.
const ROUTE_NAMES = Object.freeze(Object.fromEntries(Object.entries(ALIASES).map(([name, id]) => [id, name])));

/** The `<name>` of `/app/<name>` for registry id `id`. */
export function routeName (id) {
    return Object.hasOwn(ROUTE_NAMES, id) ? ROUTE_NAMES[id] : id;
}

/**
 * `{pathname, search}` from a Location/URL, a "/path?query" string, or (the
 * original signature) a bare "?query" string. A string is split by hand, not
 * with `new URL()`, which would resolve `/app/%2e%2e/x` to `/x` first.
 */
function split (location) {
    if ( typeof location !== 'string' ) {
        return { pathname: String(location?.pathname ?? ''), search: String(location?.search ?? '') };
    }
    if ( ! location.startsWith('/') ) return { pathname: '', search: location };
    const hashAt = location.indexOf('#');
    const beforeHash = hashAt === -1 ? location : location.slice(0, hashAt);
    const queryAt = beforeHash.indexOf('?');
    return queryAt === -1 ? { pathname: beforeHash, search: '' }
        : { pathname: beforeHash.slice(0, queryAt), search: beforeHash.slice(queryAt) };
}

/** The undecoded value of `key` in `search`, or null. Keys compare decoded. */
export function rawQueryValue (search, key) {
    for ( const pair of String(search).replace(/^\?/, '').split('&') ) {
        const eq = pair.indexOf('=');
        const name = eq === -1 ? pair : pair.slice(0, eq);
        let decoded;
        try { decoded = decodeURIComponent(name.replace(/\+/g, ' ')); } catch { decoded = name; }
        if ( decoded === key ) return eq === -1 ? '' : pair.slice(eq + 1);
    }
    return null;
}

/** Why `value` is not an acceptable project-relative path, or null if it is. */
export function pathProblem (value, raw = value) {
    if ( value === '' ) return 'empty';
    // `%2F`/`%5C` would be a second, hidden spelling of a separator.
    if ( /%(2f|5c)/i.test(raw ?? '') ) return 'encoded_separator';
    if ( new TextEncoder().encode(value).length > PATH_MAX_BYTES ) return 'too_long';
    if ( value.startsWith('/') ) return 'absolute';
    if ( value.includes('\\') ) return 'backslash';
    for ( let i = 0; i < value.length; i += 1 ) {
        const code = value.charCodeAt(i);
        if ( code < 0x20 || code === 0x7f ) return 'control';
    }
    for ( const segment of value.split('/') ) {
        if ( segment === '.' || segment === '..' ) return 'dot_segment';
        if ( ! SEGMENT.test(segment) ) return 'segment';
    }
    return null;
}

/** No lone surrogate (the same check the Worker makes; `isWellFormed` is newer than this bundle's target). */
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
 * A `folder` value → `{folder}` (a plain absolute path) or `{folderRejected}`.
 *
 * Absolute (`/workspace/a`) or relative to FOLDER_ROOT (`a`, `./a`). `.`, empty
 * segments and a trailing `/` go; `..` is resolved lexically, so a parent that
 * lands back inside is accepted (`/workspace/a/../b`) and one that climbs above
 * `/` (or, for a relative value, above FOLDER_ROOT) is `outside`. Spaces and
 * any well-formed Unicode stay as they are (no NFC: a file name is bytes). The
 * server still decides whether that folder exists, is a real directory with no
 * link on the way, and is the person's own (`outside`, `not_allowed`).
 */
export function parseFolder (value) {
    if ( typeof value !== 'string' || value === '' ) return { folderRejected: 'empty' };
    if ( ! wellFormed(value) ) return { folderRejected: 'invalid' };
    for ( let i = 0; i < value.length; i += 1 ) {
        const code = value.charCodeAt(i);
        if ( code < 0x20 || code === 0x7f ) return { folderRejected: 'control' };
        if ( code === 0x5c ) return { folderRejected: 'backslash' };
    }
    if ( new TextEncoder().encode(value).length > FOLDER_MAX_BYTES ) return { folderRejected: 'too_long' };
    const absolute = value.startsWith('/');
    const floor = absolute ? 0 : FOLDER_ROOT.split('/').length - 1;
    const segments = absolute ? [] : FOLDER_ROOT.slice(1).split('/');
    for ( const segment of value.split('/') ) {
        if ( segment === '' || segment === '.' ) continue;
        if ( segment === '..' ) {
            if ( segments.length <= floor ) return { folderRejected: 'outside' };
            segments.pop();
            continue;
        }
        if ( new TextEncoder().encode(segment).length > FOLDER_MAX_SEGMENT_BYTES ) return { folderRejected: 'too_long' };
        segments.push(segment);
    }
    if ( segments.length > FOLDER_MAX_SEGMENTS ) return { folderRejected: 'too_long' };
    const folder = `/${segments.join('/')}`;
    if ( new TextEncoder().encode(folder).length > FOLDER_MAX_BYTES ) return { folderRejected: 'too_long' };
    return { folder };
}

/**
 * Code's project parameters. Both ids are required and must be lowercase
 * canonical UUIDs; anything else drops the project (Code still opens) and
 * says why. An invalid `path` drops only the path.
 *
 * Or (founder 547ed35a) `repo` alone as a repository address: `{repoUrl}`.
 * Beside a `project` an address is ambiguous (`repo_invalid`); an address that
 * is not plain https is `repo_url_invalid`. Its `path` is not read.
 */
function parseProject (params, search) {
    const projectId = params.get('project');
    const repoId = params.get('repo');
    if ( projectId === null && repoId === null ) {
        return params.has('path') ? { projectRejected: 'project_missing' } : {};
    }
    if ( projectId === null && /^[a-z][a-z0-9+.-]*:/i.test(repoId) ) {
        return REPO_URL.test(repoId) ? { project: { repoUrl: repoId } } : { projectRejected: 'repo_url_invalid' };
    }
    if ( projectId === null || repoId === null ) {
        return { projectRejected: projectId === null ? 'project_missing' : 'repo_missing' };
    }
    if ( ! UUID.test(projectId) ) return { projectRejected: 'project_invalid' };
    if ( ! UUID.test(repoId) ) return { projectRejected: 'repo_invalid' };
    const project = { projectId, repoId };
    const path = params.get('path');
    if ( path === null ) return { project };
    const problem = pathProblem(path, rawQueryValue(search, 'path'));
    return problem ? { project, pathRejected: problem } : { project: { ...project, path } };
}

/**
 * Code's own parameters: its project (above) and its `folder`. A folder beside
 * a project or repository must stay inside that checkout, which only the
 * server can check on the computer; until it can, the folder is dropped
 * (`with_repository`) and the repository opens at its own folder. A local
 * folder link never names a project, so it never reaches Works or repo-open.
 */
function parseCode (params, search) {
    const project = parseProject(params, search);
    if ( ! params.has('folder') ) return project;
    if ( project.project ) return { ...project, folderRejected: 'with_repository' };
    return { ...project, ...parseFolder(params.get('folder')) };
}

/**
 * The query string with `/app/settings`'s `tab` spelled the alias way
 * (`settings=<tab>`), for readers that only know the alias
 * (`parseBillingDeepLink`). Any other location's query is returned as is.
 */
export function settingsAliasSearch (location) {
    const { pathname, search } = split(location);
    const params = new URLSearchParams(search);
    if ( pathname !== '/app/settings' || ! params.has('tab') || params.has('settings') ) return search;
    params.set('settings', params.get('tab'));
    params.delete('tab');
    return `?${params}`;
}

/**
 * @param {Location|URL|string} location  `window.location`, a "/path?query"
 *   string, or a bare "?query" string (the original signature).
 * @param {{id: string}[]} apps  The apps this boot may open (`registry.resolve()`).
 * @returns {{id: string, initialTab?: string, project?: {projectId: string,
 *   repoId: string, path?: string}, projectRejected?: string,
 *   pathRejected?: string, folder?: string, folderRejected?: string}|null}
 */
export function parseAppLink (location, apps) {
    const { pathname, search } = split(location);
    const params = new URLSearchParams(search);
    // Ambiguous duplicate targets must never choose a different app by parser order.
    if ( KEYS.some(key => params.getAll(key).length > 1) ) return null;
    let id;
    let section;
    if ( pathname === '/app' || pathname.startsWith('/app/') ) {
        const match = APP_PATH.exec(pathname);
        // The path names the app; a second selector in the query is a conflict.
        if ( ! match || params.has('app') ) return null;
        id = Object.hasOwn(ALIASES, match[1]) ? ALIASES[match[1]] : match[1];
        if ( id === 'settings' ) {
            if ( params.has('tab') && params.has('settings') && params.get('tab') !== params.get('settings') ) return null;
            section = params.get('tab') ?? params.get('settings');
        }
    } else {
        const requested = params.get('app');
        section = params.get('settings');
        id = requested ? (Object.hasOwn(ALIASES, requested) ? ALIASES[requested] : requested)
            : SECTIONS.has(section) ? 'settings' : null;
        if ( id === 'settings' && section === null ) section = params.get('tab');
    }
    if ( ! id || ! apps.some(app => app.id === id) ) return null;
    return {
        id,
        ...(id === 'settings' && SECTIONS.has(section) ? { initialTab: section } : {}),
        ...(id === 'code' ? parseCode(params, search) : {}),
    };
}
