/**
 * ORIGIN TIERS AND URL SANITISING — browser verbs v2, §2.
 *
 * Authority: `contract.mjs` (`ORIGIN_TIER_ENV`, `ORIGIN_TIERS`,
 * `IDP_TRANSIT_ROUTES`, `SENSITIVE_URL_PARAMS`) and
 * `docs/contracts/browser-verbs-v2.md` §2. Where this file and those disagree,
 * this file is the bug.
 *
 * Pure: no Playwright, no I/O, and no `process.env` read. The caller hands in
 * the environment once (`BrowserSurface` does, at creation) and gets back a
 * frozen policy that every other function here takes as an argument.
 *
 * ── Three tiers ─────────────────────────────────────────────────────────────
 *   owner_app    the user's own signed-in apps (staging: Universe). Every route.
 *   idp_transit  the identity provider (staging: id.ezil.work). TRANSIT ONLY:
 *                `GET /health`, `POST /navigate`, and `POST /wait_for` with
 *                `time` alone. No refs, no typing, no text, no screenshots.
 *   other        everything else: exact v1 behaviour plus the v2 verbs.
 *
 * ── Where the tier origins come from ────────────────────────────────────────
 * ONLY `EZIL_BROWSER_OWNER_APP_ORIGINS` and `EZIL_BROWSER_IDP_ORIGINS`, each a
 * comma list of bare https origins. `EZIL_BROWSER_TEST_ALLOWED_ORIGINS` is not
 * read here and never will be: that list also widens what Code chats may open,
 * so letting it mint a tier would couple two decisions that must stay apart.
 *
 * 🔴 A malformed entry in EITHER variable BREAKS THE WHOLE POLICY
 * (`policy.broken`): every URL is then `idp_transit` — transit only, for every
 * caller — until the variable is fixed, and `originPolicyBootLines` says so
 * once. (Amended 2026-11-21. Emptying just the bad tier failed OPEN: a typo in
 * the IdP list made the IdP `other`, which allows every verb, and a typo in
 * the owner list made Universe `other`, which the Code loopback does not
 * refuse.) Unset or blank variables are not malformed: that tier is empty —
 * EXCEPT that a non-empty owner list with an empty or unset IdP list is broken
 * too (amended 2026-11-22: an owner app is only safe when its IdP is known). An
 * origin listed in both variables is `idp_transit`, never `owner_app`.
 *
 * ── Policies are minted here, never hand-built ──────────────────────────────
 * `tierOf` and `sanitizeUrl` refuse (TypeError) any object that did not come
 * out of `loadOriginPolicy`. A hand-rolled `{ owner_app: [...] }` would skip
 * the strict parse below, and a wrapper that forgot to forward the policy
 * would otherwise look like "no tiers configured" — which for the Code
 * loopback means "deny nothing". Throwing makes both of those loud.
 */

import { isIP } from 'node:net';
import {
    IDP_TRANSIT_ROUTES, ORIGIN_TIER_ENV, ORIGIN_TIERS, SENSITIVE_URL_PARAMS, SIDECAR_WIRE,
} from './contract.mjs';

/** More entries than this in one variable is malformed: the policy is broken. */
export const ORIGIN_TIER_MAX_ENTRIES = 20;

/** Same host rule as `mcp-browser-open.mjs` `destination()`: dotted DNS names only. */
const DNS_HOSTNAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const SENSITIVE = new Set(SENSITIVE_URL_PARAMS);

/**
 * The names the decoded check looks for: the contract's
 * `SENSITIVE_URL_PARAMS` plus `jwt` and `accesstoken` (the 2026-11-22
 * independent review's list).
 */
export const SENSITIVE_ASSIGNMENT_NAMES = Object.freeze([...SENSITIVE_URL_PARAMS, 'jwt', 'accesstoken']);
const NAME_ALTERNATION = SENSITIVE_ASSIGNMENT_NAMES.join('|');

/**
 * A sensitive name — optionally `[]` — followed by `=`, not glued to a
 * preceding letter or digit (so `auth_code=` and `x=code=` match, `xcode=`
 * and `decode=` do not). Case-insensitive.
 */
const SENSITIVE_ASSIGNMENT = new RegExp(`(?<![A-Za-z0-9])(?:${NAME_ALTERNATION})(?:\\[\\])?\\s*=`, 'i');

/** Invisible characters an obfuscated name could hide behind (zero-width and the rest). */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** Non-fatal: bytes that are not UTF-8 decode to U+FFFD instead of throwing. */
const UTF8 = new TextDecoder('utf-8');

/** Each policy `loadOriginPolicy` minted -> its private origin sets. */
const TIER_SETS = new WeakMap();

/**
 * `https://host` or `https://host:port`, exactly as `new URL()` would print the
 * origin, or null. No path (not even `/`), no query, no userinfo, no wildcard,
 * no IP literal, no `localhost`, no default port written out, no upper case.
 * Strict on purpose: the entry must already BE its own canonical origin.
 */
function bareHttpsOrigin (entry) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 2048) return null;
    if (!entry.startsWith('https://') || /[\s\x00-\x20\x7f\\]/u.test(entry)) return null;
    let url;
    try {
        url = new URL(entry + '/');
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!DNS_HOSTNAME.test(url.hostname) || isIP(url.hostname) || url.hostname.endsWith('.localhost')) return null;
    return url.origin === entry ? entry : null;
}

/** Parse one tier variable. `ok` is false when ANY entry is malformed. */
function parseTierList (tier, variable, raw) {
    const problems = [];
    if (raw === undefined || raw === null) return { ok: true, valid: [], problems };
    if (typeof raw !== 'string') {
        problems.push({ tier, variable, entry: 0, reason: 'not_a_string' });
        return { ok: false, valid: [], problems };
    }
    const entries = raw.split(',').map((e) => e.trim()).filter((e) => e.length > 0);
    if (entries.length > ORIGIN_TIER_MAX_ENTRIES) {
        problems.push({ tier, variable, entry: 0, reason: 'too_many_entries' });
        return { ok: false, valid: [], problems };
    }
    const valid = [];
    entries.forEach((entry, index) => {
        const origin = bareHttpsOrigin(entry);
        if (origin) valid.push(origin);
        else problems.push({ tier, variable, entry: index + 1, reason: 'not_a_bare_https_origin' });
    });
    return { ok: problems.length === 0, valid, problems };
}

/**
 * Build the policy from an environment object. Reads exactly the two
 * `ORIGIN_TIER_ENV` names and nothing else.
 *
 * Returns a frozen `{ broken, owner_app, idp_transit, invalid, overlap }`:
 *   broken                   true when either variable has a malformed entry:
 *                            every URL is then `idp_transit`, and the arrays
 *                            below are empty because no list is trusted
 *   owner_app / idp_transit  the origins in each tier (frozen arrays, for logs)
 *   invalid                  `[{tier, variable, entry, reason}]` — `entry` is
 *                            the 1-based position, never the raw text (a
 *                            mistyped value can hold anything, a password in a
 *                            `user:pw@` URL included, and this goes to a log)
 *   overlap                  origins listed in both variables (all idp_transit)
 */
export function loadOriginPolicy (env) {
    const source = env && typeof env === 'object' ? env : {};
    const owner = parseTierList('owner_app', ORIGIN_TIER_ENV.owner_app, source[ORIGIN_TIER_ENV.owner_app]);
    const idp = parseTierList('idp_transit', ORIGIN_TIER_ENV.idp_transit, source[ORIGIN_TIER_ENV.idp_transit]);
    // An owner app is only safe when its IdP is known: owner origins with no
    // IdP list would let the sign-in pages be `other`. Broken too (amended
    // 2026-11-22).
    const ownerWithoutIdp = owner.ok && idp.ok && owner.valid.length > 0 && idp.valid.length === 0;
    if (ownerWithoutIdp) {
        idp.problems.push({ tier: 'idp_transit', variable: ORIGIN_TIER_ENV.idp_transit, entry: 0, reason: 'empty_with_owner_list' });
    }
    const broken = !owner.ok || !idp.ok || ownerWithoutIdp;

    const idpSet = new Set(broken ? [] : idp.valid);
    // The IdP tier matches by HOST (amended 2026-11-22), so an owner origin on
    // an IdP host — whatever its port — is an overlap and is idp_transit.
    const idpHosts = new Set([...idpSet].map((o) => new URL(o).hostname));
    const overlap = broken ? [] : [...new Set(owner.valid.filter((o) => idpHosts.has(new URL(o).hostname)))];
    const ownerSet = new Set(broken ? [] : owner.valid.filter((o) => !overlap.includes(o)));

    const policy = Object.freeze({
        broken,
        owner_app: Object.freeze([...ownerSet]),
        idp_transit: Object.freeze([...idpSet]),
        invalid: Object.freeze([...owner.problems, ...idp.problems].map((p) => Object.freeze(p))),
        overlap: Object.freeze(overlap),
    });
    TIER_SETS.set(policy, { broken, owner: ownerSet, idpHosts });
    return policy;
}

/** True only for a policy `loadOriginPolicy` returned. */
export function isOriginPolicy (policy) {
    return typeof policy === 'object' && policy !== null && TIER_SETS.has(policy);
}

function tierSets (policy) {
    const sets = typeof policy === 'object' && policy !== null ? TIER_SETS.get(policy) : undefined;
    if (!sets) throw new TypeError('not an origin policy: build one with loadOriginPolicy(env)');
    return sets;
}

/**
 * The https origin the OWNER tier matches on, or null when the URL has no
 * https origin at all (`about:blank`, `data:`, `http:` previews, opaque
 * origins). `blob:https://…` answers for its inner origin, and a trailing-dot
 * host (`app.example.com.`) answers as the same host without it.
 */
function tierOrigin (parsed) {
    const origin = parsed.origin;
    if (typeof origin !== 'string' || !origin.startsWith('https://')) return null;
    return origin.replace(/^(https:\/\/[^/:]*?)\.+(?=$|:)/, '$1');
}

function parseUrl (url) {
    try {
        return new URL(String(url));
    } catch {
        return null;
    }
}

/**
 * The host the IdP tier matches on: the hostname alone — no scheme, no port —
 * in lower case and without trailing dots. A `blob:` URL answers for its inner
 * origin's host. null when the URL has no host (`about:`, `data:`, `file:`).
 */
function hostOf (parsed) {
    let host = parsed.hostname;
    if (!host && typeof parsed.origin === 'string' && parsed.origin !== 'null') {
        const inner = parseUrl(parsed.origin);
        host = inner ? inner.hostname : '';
    }
    if (!host) return null;
    return host.toLowerCase().replace(/\.+$/, '');
}

/**
 * THE classification, for `tierOf` and `sanitizeUrl` alike. A broken policy
 * answers `idp_transit` before looking at the URL at all — parsable or not,
 * https or not — so there is exactly one place that decides it.
 *
 * The IdP tier matches by HOST whatever the scheme or port (amended
 * 2026-11-22): `http://id.ezil.work/…`, `wss://id.ezil.work/…` and
 * `https://id.ezil.work:8443/…` are all `idp_transit`. The owner tier stays an
 * exact https-origin match.
 */
function classify (sets, parsed) {
    if (sets.broken) return 'idp_transit';
    if (parsed === null) return 'other';
    const host = hostOf(parsed);
    if (host !== null && sets.idpHosts.has(host)) return 'idp_transit';
    const origin = tierOrigin(parsed);
    if (origin === null) return 'other';
    if (sets.owner.has(origin)) return 'owner_app';
    return 'other';
}

/**
 * `owner_app | idp_transit | other` for a URL. Anything unparsable is
 * `other` — except under a broken policy, where EVERYTHING is `idp_transit`.
 */
export function tierOf (url, policy) {
    return classify(tierSets(policy), parseUrl(url));
}

/**
 * May `route` run while the page it acts on is in `tier`? `owner_app` and
 * `other` allow every declared route; `idp_transit` allows `IDP_TRANSIT_ROUTES`
 * only, and `/wait_for` there only with `time` and no `text` at all (an empty
 * or non-string `text` still counts as asking for text). An undeclared route
 * or an unknown tier is refused.
 */
export function routeAllowedOnTier (route, tier, body) {
    if (!Object.hasOwn(SIDECAR_WIRE, route) || !ORIGIN_TIERS.includes(tier)) return false;
    if (tier !== 'idp_transit') return true;
    if (!IDP_TRANSIT_ROUTES.includes(route)) return false;
    if (route === 'POST /wait_for') {
        const b = body !== null && typeof body === 'object' ? body : {};
        const noText = b.text === undefined || b.text === null;
        const hasTime = b.time !== undefined && b.time !== null;
        return noText && hasTime;
    }
    return true;
}

/** Decode one parameter name the way a server would read it, then fold case. */
function paramName (raw) {
    let name = raw.replace(/\+/g, ' ');
    try {
        name = decodeURIComponent(name);
    } catch { /* malformed escapes: compare the raw form */ }
    return name.trim().toLowerCase();
}

/**
 * Does a query (`?…`) or fragment (`#…`) carry a sensitive parameter NAME?
 *
 * Split on every separator a parameter can follow — `?`, `#`, `&`, `;` — not
 * just `&`, because the shapes that matter are not all well-formed queries:
 * the implicit-flow fragment `#access_token=…&state=…`, the hash-router
 * fragment `#/callback?code=…`, and a doubled `?x=1?code=…` all put the name
 * somewhere `URLSearchParams` would not. A name with no `=` still counts.
 */
function hasSensitiveParam (part) {
    if (typeof part !== 'string' || part.length < 2) return false;
    for (const token of part.split(/[?#&;]/)) {
        if (!token) continue;
        const eq = token.indexOf('=');
        if (SENSITIVE.has(paramName(eq === -1 ? token : token.slice(0, eq)))) return true;
    }
    return false;
}

/** Percent-decode ONCE, valid UTF-8 or not: a bad byte becomes U+FFFD, never a throw. */
function decodeOnce (text) {
    return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => (
        UTF8.decode(Uint8Array.from(run.slice(1).split('%'), (hex) => Number.parseInt(hex, 16)))
    ));
}

/**
 * Does this text carry a sensitive `name=`? Read the way a server would:
 * `+` as a space, percent-decoded once (so a URL nested in a parameter value
 * is read too), and with invisible characters removed (so `%E2%80%8Bcode=`
 * and a name split by a zero-width character still match).
 */
function carriesSensitive (text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return SENSITIVE_ASSIGNMENT.test(decodeOnce(text.replace(/\+/g, ' ')).replace(IGNORABLE, ''));
}

function remainderOf (parsed) {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function userinfoOf (parsed) {
    return parsed.username || parsed.password ? `${parsed.username}:${parsed.password}` : '';
}

/**
 * The amended check (2026-11-22): the remainder after the origin — path with
 * its `;` parameters, query, fragment — decoded once and matched against
 * `SENSITIVE_ASSIGNMENT`; the userinfo the same way; and, as before, a
 * sensitive parameter NAME (even with no `=`) in the query or fragment.
 */
function urlCarriesSensitive (parsed) {
    return carriesSensitive(remainderOf(parsed)) || carriesSensitive(userinfoOf(parsed))
        || hasSensitiveParam(parsed.search) || hasSensitiveParam(parsed.hash);
}

/** Every `;` parameter removed from every path segment. */
function withoutPathParams (pathname) {
    return pathname.split('/').map((segment) => segment.split(';')[0]).join('/');
}

const WEB_SCHEME = /^(?:https?|wss?|ftp):$/;

/**
 * The URL with what may not leave removed.
 *
 *   transit (idp_transit, or anything under a broken policy): no userinfo, no
 *     query, no fragment — origin + path for the web schemes, the inner origin
 *     for `blob:`, the URL without query and fragment for anything else;
 *   sensitive: no query, no fragment, no `;` path parameters, and no userinfo
 *     when that is where the name was.
 *
 * If what is left STILL carries a sensitive `name=` (it was in the path
 * proper, or behind an encoded `;`), only the origin leaves — or, for a URL
 * with no origin, its scheme.
 */
function reduced (parsed, transit, sensitive) {
    if (parsed.protocol === 'blob:') return parsed.origin === 'null' ? 'blob:' : parsed.origin;
    const web = WEB_SCHEME.test(parsed.protocol);
    const clean = new URL(parsed.href);
    clean.search = '';
    clean.hash = '';
    if ((transit && web) || carriesSensitive(userinfoOf(clean))) {
        clean.username = '';
        clean.password = '';
    }
    if (sensitive && clean.pathname.startsWith('/')) clean.pathname = withoutPathParams(clean.pathname);
    if (!urlCarriesSensitive(clean)) return clean.href;
    if (web) return `${clean.origin}/`;
    return clean.host ? `${clean.protocol}//${clean.host}` : clean.protocol;
}

/**
 * The URL as it may leave this process.
 *
 *   idp_transit URL                    -> origin + path, whatever it carries
 *                                         (EVERY URL, under a broken policy)
 *   a sensitive `name=` anywhere after
 *   the origin (decoded once), or a
 *   sensitive name in query/fragment   -> without query, fragment and `;`
 *                                         path parameters
 *   anything else                      -> the SAME string, untouched
 *   not a string / not a URL           -> returned unchanged
 *
 * Untouched means byte-for-byte: a URL that needs nothing removed is not
 * re-serialised, so `other` pages keep exact v1 URLs.
 */
export function sanitizeUrl (url, policy) {
    const sets = tierSets(policy);
    if (typeof url !== 'string') return url;
    const parsed = parseUrl(url);
    if (parsed === null) return url;
    const transit = classify(sets, parsed) === 'idp_transit';
    const sensitive = urlCarriesSensitive(parsed);
    if (!transit && !sensitive) return url;
    return reduced(parsed, transit, sensitive);
}

/**
 * Free text as it may leave: console lines, snapshot text, `get_text`
 * markdown, titles, option values.
 *
 * Pass 1, absolute URLs: every `http(s)://…` through `sanitizeUrl`, including
 * the JSON-escaped form (`https:\/\/host\/cb?code=…`, PHP's default), which is
 * unescaped to sanitise and re-escaped only if something was removed.
 *
 * Pass 2, relative references, because markdown carries the page's raw
 * `href`s and most are relative: `/cb?code=…`, `./cb?state=…`, `?code=…`,
 * `#access_token=…` and protocol-relative `//host/cb?…`, wherever one starts
 * after whitespace, a quote, `(`, `[`, `<`, `=` or the start of the text. A
 * path keeps its path and loses query and fragment when either names a
 * sensitive parameter (always, under a broken policy); `//host…` goes through
 * `sanitizeUrl` as if it were `https:`.
 *
 * A URL ends at whitespace, a quote, `<`, `>` or a backtick. Trailing sentence
 * punctuation and an unbalanced `)` or `]` are not part of it, so
 * `[label](https://…?code=…)` keeps its closing bracket.
 */
const ABSOLUTE_URL_IN_TEXT = /https?:(?:\/\/|\\\/\\\/)[^\s"'<>`]+/gi;
const RELATIVE_REF_IN_TEXT = /(^|[\s"'(\[<=])((?:\\?\/|\.\.?\\?\/|[?#])[^\s"'<>`]*)/g;

const occurrences = (s, ch) => s.split(ch).length - 1;

/** `[url, trailer]`: trailing `.,;:!?` and unbalanced `)`/`]` moved out of a match. */
function splitTrailer (match) {
    let end = match.length;
    for (;;) {
        const head = match.slice(0, end);
        const c = head[end - 1];
        if (end > 1 && '.,;:!?'.includes(c)) { end -= 1; continue; }
        if (c === ')' && occurrences(head, '(') < occurrences(head, ')')) { end -= 1; continue; }
        if (c === ']' && occurrences(head, '[') < occurrences(head, ']')) { end -= 1; continue; }
        return [head, match.slice(end)];
    }
}

/** Run `clean` on the unescaped form of a `\/`-escaped match, re-escaping only if it changed. */
function throughEscapes (match, clean) {
    const escaped = match.includes('\\/');
    const plain = escaped ? match.replace(/\\\//g, '/') : match;
    const out = clean(plain);
    if (out === plain) return match;
    return escaped ? out.replace(/\//g, '\\/') : out;
}

function sanitizeRelative (ref, sets, policy) {
    if (ref.startsWith('//')) {
        const absolute = `https:${ref}`;
        const out = sanitizeUrl(absolute, policy);
        return out === absolute ? ref : out.replace(/^https:/, '');
    }
    const cut = ref.search(/[?#]/);
    const head = cut === -1 ? ref : ref.slice(0, cut);
    const rest = cut === -1 ? '' : ref.slice(cut);
    const hashAt = rest.indexOf('#');
    const query = hashAt === -1 ? rest : rest.slice(0, hashAt);
    const fragment = hashAt === -1 ? '' : rest.slice(hashAt);
    // The same decoded check as `sanitizeUrl`, over the whole reference.
    const sensitive = carriesSensitive(ref) || hasSensitiveParam(query) || hasSensitiveParam(fragment);
    // Under a broken policy (`classify(sets, null)` is transit for everything)
    // a reference WITH a path takes the transit form. A bare `#…`/`?…` token
    // has no path and may be a heading or an anchor, so it only loses what
    // names a sensitive parameter.
    const transit = cut > 0 && classify(sets, null) === 'idp_transit';
    if (!sensitive && !transit) return ref;
    const out = sensitive ? withoutPathParams(head) : head;
    // A path that still carries `name=` itself is dropped whole.
    return carriesSensitive(out) ? '' : out;
}

export function sanitizeText (text, policy) {
    const sets = tierSets(policy);
    if (typeof text !== 'string' || text.length === 0) return text;
    const absolute = text.replace(ABSOLUTE_URL_IN_TEXT, (match) => {
        const [url, trailer] = splitTrailer(match);
        const out = throughEscapes(url, (plain) => sanitizeUrl(plain, policy));
        return out === url ? match : out + trailer;
    });
    return absolute.replace(RELATIVE_REF_IN_TEXT, (all, lead, ref) => {
        const [core, trailer] = splitTrailer(ref);
        const out = throughEscapes(core, (plain) => sanitizeRelative(plain, sets, policy));
        return out === core ? all : lead + out + trailer;
    });
}

/**
 * The boot-log lines for a policy. A broken policy is ONE line naming every
 * fault (variable and position, never a raw value); a sound one gets a line
 * per overlap origin; a clean one gets none.
 */
export function originPolicyBootLines (policy) {
    tierSets(policy);
    if (policy.broken) {
        const faults = policy.invalid.map((p) => {
            if (p.reason === 'too_many_entries') return `${p.variable} has more than ${ORIGIN_TIER_MAX_ENTRIES} entries`;
            if (p.reason === 'not_a_string') return `${p.variable} is not a string`;
            if (p.reason === 'empty_with_owner_list') {
                return `${p.variable} is empty while ${ORIGIN_TIER_ENV.owner_app} is set (an owner app needs its IdP)`;
            }
            return `${p.variable} entry #${p.entry} is not a bare https origin (https://host[:port], no path, no wildcard)`;
        });
        return [
            `[ezil-sidecar] origin policy BROKEN — ${faults.join('; ')}: every page is idp_transit `
            + '(health, navigate and wait_for{time} only) until it is fixed',
        ];
    }
    return policy.overlap.map((origin) => (
        `[ezil-sidecar] ${origin} is in both ${ORIGIN_TIER_ENV.owner_app} and ${ORIGIN_TIER_ENV.idp_transit}: it is idp_transit`
    ));
}
