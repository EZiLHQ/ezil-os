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
 * refuse.) Unset or blank variables are not malformed: that tier is empty. An
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
    const broken = !owner.ok || !idp.ok;

    const overlap = broken ? [] : [...new Set(owner.valid.filter((o) => idp.valid.includes(o)))];
    const idpSet = new Set(broken ? [] : idp.valid);
    const ownerSet = new Set(broken ? [] : owner.valid.filter((o) => !idpSet.has(o)));

    const policy = Object.freeze({
        broken,
        owner_app: Object.freeze([...ownerSet]),
        idp_transit: Object.freeze([...idpSet]),
        invalid: Object.freeze([...owner.problems, ...idp.problems].map((p) => Object.freeze(p))),
        overlap: Object.freeze(overlap),
    });
    TIER_SETS.set(policy, { broken, owner: ownerSet, idp: idpSet });
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
 * The origin to look up, from a parsed URL, or null when the URL has no
 * https origin at all (`about:blank`, `data:`, `http:` previews, opaque
 * origins). `blob:https://…` answers for its inner origin, and a trailing-dot
 * host (`id.ezil.work.`) answers as the same host without it.
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
 * THE classification, for `tierOf` and `sanitizeUrl` alike. A broken policy
 * answers `idp_transit` before looking at the URL at all — parsable or not,
 * https or not — so there is exactly one place that decides it.
 */
function classify (sets, parsed) {
    if (sets.broken) return 'idp_transit';
    if (parsed === null) return 'other';
    const origin = tierOrigin(parsed);
    if (origin === null) return 'other';
    if (sets.idp.has(origin)) return 'idp_transit';
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

/**
 * An `idp_transit` URL as it may leave: origin + path for the web schemes
 * (which also drops userinfo), the inner origin for `blob:`, and for anything
 * else (`about:`, `data:`, `chrome-error:`) the URL without query and
 * fragment. Under a broken policy every URL takes this form.
 */
function transitForm (parsed) {
    if (/^(?:https?|wss?):$/.test(parsed.protocol)) return `${parsed.origin}${parsed.pathname}`;
    if (parsed.protocol === 'blob:') return parsed.origin === 'null' ? 'blob:' : parsed.origin;
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
}

/**
 * The URL as it may leave this process.
 *
 *   idp_transit URL                    -> origin + path, whatever it carries
 *                                         (EVERY URL, under a broken policy)
 *   query or fragment names a
 *   SENSITIVE_URL_PARAMS parameter     -> the URL without query AND fragment
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
    if (classify(sets, parsed) === 'idp_transit') return transitForm(parsed);
    if (hasSensitiveParam(parsed.search) || hasSensitiveParam(parsed.hash)) {
        parsed.search = '';
        parsed.hash = '';
        return parsed.href;
    }
    return url;
}

/**
 * Every http(s) URL inside free text, through `sanitizeUrl`. Also catches the
 * JSON-escaped form (`https:\/\/host\/cb?code=…`, PHP's default), which is
 * unescaped to sanitise and re-escaped only if something was removed. A URL
 * ends at whitespace, a quote, `<`, `>` or a backtick.
 */
const URL_IN_TEXT = /https?:(?:\/\/|\\\/\\\/)[^\s"'<>`]+/gi;

export function sanitizeText (text, policy) {
    tierSets(policy);
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.replace(URL_IN_TEXT, (match) => {
        const escaped = match.includes('\\/');
        const plain = escaped ? match.replace(/\\\//g, '/') : match;
        const clean = sanitizeUrl(plain, policy);
        if (clean === plain) return match;
        return escaped ? clean.replace(/\//g, '\\/') : clean;
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
        const faults = policy.invalid.map((p) => (p.reason === 'too_many_entries'
            ? `${p.variable} has more than ${ORIGIN_TIER_MAX_ENTRIES} entries`
            : p.reason === 'not_a_string'
                ? `${p.variable} is not a string`
                : `${p.variable} entry #${p.entry} is not a bare https origin (https://host[:port], no path, no wildcard)`));
        return [
            `[ezil-sidecar] origin policy BROKEN — ${faults.join('; ')}: every page is idp_transit `
            + '(health, navigate and wait_for{time} only) until it is fixed',
        ];
    }
    return policy.overlap.map((origin) => (
        `[ezil-sidecar] ${origin} is in both ${ORIGIN_TIER_ENV.owner_app} and ${ORIGIN_TIER_ENV.idp_transit}: it is idp_transit`
    ));
}
