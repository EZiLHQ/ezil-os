// Explicit shell entry intent. Browser's internal app id remains `desktop`.
// Two spellings reach the same app: the canonical path form `/app/<id>?…` and
// the older query alias `/os?app=<id>` / `/os?settings=<tab>` (app-history.js
// rewrites the alias to the path form). See docs/APP-ROUTES.md.
// Project parameters are PARSED here and nothing more: no arbitrary URL is
// used as an iframe target, and a repo URL, ref, folder, account id or token
// in the URL is never read.
export const ALIASES = Object.freeze({ browser: 'desktop' });
export const SECTIONS = new Set(['account', 'usage', 'billing', 'computers', 'system', 'appearance', 'about', 'troubleshoot']);
// Every key this parser reads. A repeated one makes the whole link ambiguous.
const KEYS = ['app', 'settings', 'tab', 'project', 'repo', 'path'];
const APP_PATH = /^\/app\/([a-z0-9-]+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const PATH_MAX_BYTES = 255;

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

/**
 * Code's project parameters. Both ids are required and must be lowercase
 * canonical UUIDs; anything else drops the project (Code still opens) and
 * says why. An invalid `path` drops only the path.
 */
function parseProject (params, search) {
    const projectId = params.get('project');
    const repoId = params.get('repo');
    if ( projectId === null && repoId === null ) {
        return params.has('path') ? { projectRejected: 'project_missing' } : {};
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
 *   pathRejected?: string}|null}
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
        ...(id === 'code' ? parseProject(params, search) : {}),
    };
}
