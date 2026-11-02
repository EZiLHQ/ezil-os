#!/usr/bin/env node
// Validates docs/contracts/universe-repo-open-v1.vectors.json against itself
// and against the OS deep-link parser, then prints the vectors' sha256.
//
//   node docs/contracts/universe-repo-open-v1.check.mjs
//   bun  docs/contracts/universe-repo-open-v1.check.mjs
//   node docs/contracts/universe-repo-open-v1.check.mjs --emit-gateway-extract > <file>
//
// Exit 0 only when every check passes AND the vectors sha256 and the gateway
// extract sha256 equal the values pinned in README-universe-repo-open.md.
// With --emit-gateway-extract the extract bytes go to stdout (status to
// stderr), and only when every check passes. No dependencies; never touches
// the network. The reference functions below are the executable reading of
// the contract; lane tests must agree with them case for case.

import { existsSync, readFileSync } from 'node:fs';
import { createHash, createHmac, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = join(HERE, 'universe-repo-open-v1.vectors.json');
const README_PATH = join(HERE, 'README-universe-repo-open.md');
const APP_LINK_PATH = join(HERE, '..', '..', 'shell', 'ezil', 'app-link.js');
const REPO_ROOT = join(HERE, '..', '..');
const CONTRACT_PATH = join(HERE, 'universe-repo-open-v1.md');

const EMIT_GATEWAY_EXTRACT = process.argv.includes('--emit-gateway-extract');
const failures = [];
const skipped = [];
let checks = 0;
function ok(cond, message) {
    checks += 1;
    if (!cond) failures.push(message);
}
function eq(actual, expected, message) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    ok(a === e, `${message}: expected ${e}, got ${a}`);
}

const raw = readFileSync(VECTORS_PATH);
const sha256 = createHash('sha256').update(raw).digest('hex');
let V;
try { V = JSON.parse(raw.toString('utf8')); } catch (err) {
    console.error(`vectors: not JSON (${err.message})`);
    process.exit(1);
}

// ── expansion and hygiene ────────────────────────────────────────────────────
const expand = (s) => typeof s === 'string'
    ? s.replace(/\$\{repeat:([\s\S]):(\d+)\}/g, (_, c, n) => c.repeat(Number(n)))
    : s;
for (const [input, output] of V.expansion.examples) eq(expand(input), output, `expansion ${input}`);

const text = raw.toString('utf8');
ok(!/egg_[0-9a-f]{64}/.test(text), 'hygiene: a literal grant-shaped string is committed (use ${repeat:...})');
ok(!/eyJ[A-Za-z0-9_-]{8,}/.test(text), 'hygiene: a JWT-shaped string is committed');
ok(!/BEGIN [A-Z ]*PRIVATE KEY/.test(text), 'hygiene: key material is committed');
const C = V.constants;
const PROD = C.PRODUCTION_AUTH0_CLIENTS;
const allStrings = [];
(function walk(node) {
    if (typeof node === 'string') allStrings.push(node);
    else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) { allStrings.push(k); walk(v); }
})(V);
// Auth0 client ids are 32 mixed-case alphanumerics; a 32-character lowercase
// hex string is a hyphenless UUID case, not a client id.
for (const s of allStrings) {
    if (/^[A-Za-z0-9]{32}$/.test(s) && !/^[0-9a-f]{32}$/.test(s)) ok(PROD.includes(s), `hygiene: unexpected 32-character client-id-shaped value ${s}`);
}
// 1.0.2: at least the CLI and Universe web ids; a later bump may add the production OS app's
// client (productionOs.pinGate production_client_unlisted) without touching this check.
ok(PROD.length >= 2 && new Set(PROD).size === PROD.length && PROD.every((c) => /^[A-Za-z0-9]{32}$/.test(c))
    && PROD.includes('Mzvm4piCMAKy3ofhywuQDYstJLcYE3mx') && PROD.includes('2tVk0vvzQvm964BtGuXzQxpjlo2JCoCl'),
    'PRODUCTION_AUTH0_CLIENTS: distinct 32-character ids including the CLI and Universe web clients');

// ── version and constants ────────────────────────────────────────────────────
ok(V.contract === 'universe-repo-open-v1', 'contract name');
ok(V.contractVersion === '1.0.3', 'contractVersion is "1.0.3"');
for (const name of V.requiredConstants) ok(Object.hasOwn(C, name), `constants: ${name} missing`);
ok(C.CLIENT_ID_UNPINNED === 'UNPINNED', 'CLIENT_ID_UNPINNED');
for (const key of ['OS_STAGING_ORIGIN', 'WORKS_STAGING_ORIGIN', 'PREVIEW_SUPABASE_ORIGIN']) {
    const u = new URL(C[key]);
    ok(u.protocol === 'https:' && u.origin === C[key], `${key} is a bare https origin`);
}
for (const host of [C.GIT_STAGING_HOST, C.GIT_ASSESSMENT_HOST, new URL(C.WORKS_STAGING_ORIGIN).host, C.UNIVERSE_STAGING_HOST, new URL(C.OS_STAGING_ORIGIN).host]) {
    ok(!C.STAGING_FORBIDDEN_HOSTS.includes(host), `staging host ${host} is on the forbidden list`);
}
// 1.0.3: the request class → git host table is closed, total and injective.
{
    const T = C.REPO_OPEN_CLASS_GIT_HOSTS;
    eq(C.REPO_OPEN_CLASSES, ['personal', 'assessment'], 'REPO_OPEN_CLASSES');
    eq(Object.keys(T), C.REPO_OPEN_CLASSES, 'REPO_OPEN_CLASS_GIT_HOSTS covers exactly REPO_OPEN_CLASSES');
    ok(C.REPO_OPEN_CLASS_DEFAULT === 'personal' && T.personal === C.GIT_STAGING_HOST && T.assessment === C.GIT_ASSESSMENT_HOST,
        'class table: personal (the default) is GIT_STAGING_HOST, assessment is GIT_ASSESSMENT_HOST');
    ok(new Set(Object.values(T)).size === Object.values(T).length && !Object.values(T).includes(C.GIT_PRODUCTION_HOST),
        'class table: one distinct host per class, never GIT_PRODUCTION_HOST');
}
ok(C.STAGING_FORBIDDEN_HOSTS.includes(C.GIT_PRODUCTION_HOST), 'GIT_PRODUCTION_HOST is forbidden on staging');
ok(!C.GATEWAY_TAKEN_RL_NAMESPACES.includes(C.GATEWAY_PREVIEW_RL_NAMESPACE), 'preview RL namespace collides');
ok(!C.OS_PRODUCTION_ORIGINS.includes(C.OS_STAGING_ORIGIN), 'staging origin listed as production');
// 1.0.2 (D1): production OS is os.ezil.work (release-state.mjs canonical); os.ezil.org is the landing page.
ok(C.OS_PRODUCTION_ORIGINS.includes(C.OS_PRODUCTION_APP_ORIGIN) && C.OS_PRODUCTION_ORIGINS.includes(C.OS_LANDING_ORIGIN)
    && C.OS_PRODUCTION_APP_ORIGIN !== C.OS_LANDING_ORIGIN, 'OS_PRODUCTION_APP_ORIGIN and OS_LANDING_ORIGIN are distinct production origins');
{
    let releaseState = '';
    try { releaseState = readFileSync(join(REPO_ROOT, V.productionOs.canonicalSource), 'utf8'); } catch { releaseState = ''; }
    const canonical = /^export const canonical = '([^']+)';$/m.exec(releaseState)?.[1];
    eq(canonical, C.OS_PRODUCTION_APP_ORIGIN, `OS_PRODUCTION_APP_ORIGIN equals ${V.productionOs.canonicalSource} canonical`);
}
ok(C.REAUTH_PARAM === 'returnUrl' && C.REAUTH_FORBIDDEN_PARAM === 'returnTo', 'reauth parameter is returnUrl');

// ── regex ────────────────────────────────────────────────────────────────────
const PREDICATES = {
    no_double_dot: (s) => !s.includes('..'),
    no_git_suffix: (s) => !s.endsWith('.git'),
    no_double_slash: (s) => !s.includes('//'),
    no_trailing_slash: (s) => !s.endsWith('/'),
    no_lock_suffix: (s) => !s.endsWith('.lock'),
    no_component_leading_dot: (s) => !s.includes('/.'),
    no_trailing_dot: (s) => !s.endsWith('.'),
    int64_max: (s) => /^[0-9]+$/.test(s) && BigInt(s) <= 9223372036854775807n,
};
for (const name of Object.keys(PREDICATES)) ok(Object.hasOwn(V.predicates, name), `predicate ${name} undocumented`);
for (const name of Object.keys(V.predicates)) ok(Object.hasOwn(PREDICATES, name), `predicate ${name} unimplemented in check.mjs`);

function compile(spec, label) {
    for (const p of spec.predicates) ok(Object.hasOwn(PREDICATES, p), `${label}: unknown predicate ${p}`);
    let re;
    try { re = new RegExp(spec.source); } catch (err) { ok(false, `${label}: does not compile (${err.message})`); return () => false; }
    return (value) => typeof value === 'string' && re.test(value) && spec.predicates.every((p) => PREDICATES[p](value));
}
const R = Object.fromEntries(Object.entries(V.regex).map(([k, spec]) => [k, compile(spec, k)]));
const U = Object.fromEntries(Object.entries(V.upstreamPatterns).map(([k, spec]) => [k, compile(spec, `upstream ${k}`)]));
for (const [name, cases] of Object.entries(V.regexCases)) {
    ok(Object.hasOwn(R, name), `regexCases: ${name} has no regex`);
    ok(cases.valid.length > 0 && cases.invalid.length > 0, `regexCases: ${name} needs valid and invalid cases`);
    for (const v of cases.valid) ok(R[name](expand(v)), `${name}: valid case rejected: ${JSON.stringify(v)}`);
    for (const v of cases.invalid) ok(!R[name](expand(v)), `${name}: invalid case accepted: ${JSON.stringify(v)}`);
}
for (const name of ['UUID_RE', 'HANDLE_RE', 'NAME_RE', 'BRANCH_RE', 'GRANT_RE', 'COMPUTER_LABEL_RE', 'SANDBOX_NAME_RE']) {
    ok(V.regexCases[name].invalid.some((v) => expand(v).endsWith('\n')), `${name}: needs a trailing-newline invalid case`);
}
// Structural subset (regexRelationsRule). A position-class language is fixed by
// a first-, middle- and last-character class, a single-character class and a
// length set; the profile derives them by probing, then a seeded sample proves
// the profile reproduces the pattern before any containment is trusted.
const PROBE_CHARS = [...Array(95)].map((_, i) => String.fromCharCode(32 + i))
    .concat(['\n', '\t', '\r', '\u0000', '\u007f', 'é', 'ß', ' ', 'а']);
const PROBE_MAX_LENGTH = 300;
function profile(test) {
    const p = { first: new Set(), middle: new Set(), last: new Set(), single: new Set(), lengths: new Set() };
    for (const ch of PROBE_CHARS) {
        if (test(ch)) p.single.add(ch);
        if (test(ch + 'a')) p.first.add(ch);
        if (test('a' + ch + 'a')) p.middle.add(ch);
        if (test('a' + ch)) p.last.add(ch);
    }
    for (let n = 1; n <= PROBE_MAX_LENGTH; n += 1) if (test('a'.repeat(n))) p.lengths.add(n);
    return p;
}
function profileAccepts(p, predicates, s) {
    const chars = [...s];
    const n = chars.length;
    if (!p.lengths.has(n)) return false;
    const classes = n === 1 ? p.single.has(chars[0])
        : p.first.has(chars[0]) && p.last.has(chars[n - 1]) && chars.slice(1, -1).every((c) => p.middle.has(c));
    return classes && predicates.every((name) => PREDICATES[name](s));
}
function seededSample(seed) {
    let x = seed >>> 0;
    return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; };
}
function verifyProfile(label, test, spec, p) {
    const rand = seededSample(0x5eed + label.length);
    const pool = [...new Set([...p.first, ...p.middle, ...p.last, ...p.single])];
    let disagreements = 0;
    for (let i = 0; i < 3000; i += 1) {
        const n = 1 + Math.floor(rand() * Math.min(PROBE_MAX_LENGTH, Math.max(...p.lengths, 1) + 3));
        let s = '';
        for (let j = 0; j < n; j += 1) {
            const fromPool = pool.length > 0 && rand() < 0.95;
            s += fromPool ? pool[Math.floor(rand() * pool.length)] : PROBE_CHARS[Math.floor(rand() * PROBE_CHARS.length)];
        }
        if (test(s) !== profileAccepts(p, spec.predicates, s)) disagreements += 1;
    }
    ok(disagreements === 0, `relation: ${label} is not a position-class pattern (${disagreements} sampled disagreements)`);
}
const subsetOf = (a, b) => [...a].every((x) => b.has(x));
for (const rel of V.regexRelations) {
    const a = V.regex[rel.a], b = V.upstreamPatterns[rel.b];
    ok(a && b, `relation ${rel.a} ${rel.kind} ${rel.b}: unknown pattern`);
    if (!a || !b) continue;
    if (rel.kind === 'equal') {
        ok(a.source === b.source && JSON.stringify([...a.predicates].sort()) === JSON.stringify([...b.predicates].sort()),
            `relation: ${rel.a} must equal ${rel.b}`);
    } else if (rel.kind === 'subset') {
        const pa = profile(R[rel.a]), pb = profile(U[rel.b]);
        verifyProfile(rel.a, R[rel.a], a, pa);
        verifyProfile(rel.b, U[rel.b], b, pb);
        for (const cls of ['first', 'middle', 'last', 'single', 'lengths']) {
            ok(pa[cls].size > 0 && subsetOf(pa[cls], pb[cls]), `relation: ${rel.a} ${cls} class is not inside ${rel.b}`);
        }
        ok(b.predicates.every((name) => a.predicates.includes(name)), `relation: ${rel.b} predicates are not all enforced by ${rel.a}`);
        for (const v of V.regexCases[rel.a].valid) ok(U[rel.b](expand(v)), `relation: ${rel.a} valid case ${JSON.stringify(v)} outside ${rel.b}`);
    } else ok(false, `relation kind ${rel.kind}`);
}

// ── OS deep-link parser (the real a988f28c module) ───────────────────────────
const appLink = await import(pathToFileURL(APP_LINK_PATH).href);
const appLinkText = readFileSync(APP_LINK_PATH, 'utf8');
const uuidLiteral = /const UUID = \/(.+)\/;/.exec(appLinkText);
ok(uuidLiteral && uuidLiteral[1] === V.upstreamPatterns['os.appLinkUuid'].source, 'app-link.js UUID differs from os.appLinkUuid');
for (const c of V.link.parser) eq(appLink.parseAppLink(c.location, [{ id: 'code' }]), c.expect, `parser ${c.location}`);
for (const v of V.link.path.valid) eq(appLink.pathProblem(expand(v), expand(v)), null, `path valid ${v.slice(0, 40)}`);
for (const [value, rawValue, reason] of V.link.path.invalid) eq(appLink.pathProblem(expand(value), expand(rawValue)), reason, `path invalid ${JSON.stringify(value).slice(0, 40)}`);
const pathOk = (p) => typeof p === 'string' && appLink.pathProblem(p, p) === null;

// ── link emitter (Universe OsLaunch.php authority; ProjectBoard.tsx defence) ──
function canonicalLink(project, repo) { return `${C.OS_STAGING_ORIGIN}/app/code?project=${project}&repo=${repo}`; }
function emitterValid(s) {
    let url;
    try { url = new URL(s); } catch { return false; }
    if (url.origin !== C.OS_STAGING_ORIGIN || url.username || url.password || url.port || url.hash || s.includes('#')) return false;
    if (url.pathname !== '/app/code') return false;
    const keys = [...url.searchParams.keys()];
    if (keys.length !== 2 || keys[0] !== 'project' || keys[1] !== 'repo') return false;
    const project = url.searchParams.get('project'), repo = url.searchParams.get('repo');
    return R.UUID_RE(project) && R.UUID_RE(repo) && s === canonicalLink(project, repo);
}
for (const s of V.link.emitter.valid) ok(emitterValid(s), `emitter valid rejected: ${s}`);
for (const [s, why] of V.link.emitter.invalid) ok(!emitterValid(s), `emitter invalid (${why}) accepted: ${s}`);

// ── EzilHosts and board execution ────────────────────────────────────────────
function ezilHosts(appUrl) {
    let url;
    try { url = new URL(appUrl); } catch { return { osOrigin: null, gitHost: C.GIT_PRODUCTION_HOST }; }
    const staging = url.protocol === 'https:' && url.hostname === C.UNIVERSE_STAGING_HOST && url.port === '' && !url.username && !url.password;
    return staging ? { osOrigin: C.OS_STAGING_ORIGIN, gitHost: C.GIT_STAGING_HOST } : { osOrigin: null, gitHost: C.GIT_PRODUCTION_HOST };
}
for (const c of V.ezilHosts) eq(ezilHosts(c.appUrl), c.expect, `ezilHosts ${c.appUrl}`);
function cloneHostOk(cloneUrl, gitHost) {
    if (typeof cloneUrl !== 'string') return false;
    try { const u = new URL(cloneUrl); return u.protocol === 'https:' && u.hostname === gitHost && !u.port && !u.username && !u.password; } catch { return false; }
}
function boardExecution(i) {
    const none = (state, reason) => ({ state, reason, launchUrl: null });
    const hosts = ezilHosts(i.appUrl);
    if (!hosts.osOrigin) return none('blocked', 'os_contract_unavailable');
    if (i.worksRepositoryRef === null) return none('unavailable', 'repository_not_connected');
    if (!R.UUID_RE(i.publicId)) return none('unavailable', 'project_unsupported');
    if (!R.UUID_RE(i.repositoryId)) return none('unavailable', 'repository_unsupported');
    if (!cloneHostOk(i.cloneUrl, hosts.gitHost)) return none('unavailable', 'repository_other_environment');
    if (i.launchVerified !== true) return none('os_launch_pending', 'launch_not_verified');
    return { state: 'ready', reason: null, launchUrl: canonicalLink(i.publicId, i.repositoryId) };
}
for (const c of V.boardExecution.cases) {
    const got = boardExecution(c.input);
    eq(got, c.expect, `boardExecution ${c.name}`);
    ok(V.boardExecution.states.includes(c.expect.state), `boardExecution ${c.name}: unknown state`);
    if (c.expect.launchUrl !== null) ok(emitterValid(c.expect.launchUrl), `boardExecution ${c.name}: launchUrl not canonical`);
}

// ── activation ───────────────────────────────────────────────────────────────
const ids = V.fixtures.clientIds;
const resolveClient = (sym) => sym === null ? null : sym === 'UNPINNED' ? 'UNPINNED' : ids[sym];
for (const sym of Object.keys(ids)) ok(ids[sym] !== 'UNPINNED', `fixture client ${sym}`);
ok(PROD.includes(ids.PROD_CLI) && PROD.includes(ids.PROD_UNIVERSE_WEB), 'fixture production clients');
ok(!PROD.includes(ids.OS_STAGING) && !PROD.includes(ids.UNIVERSE_STAGING), 'fixture staging clients must not be production ids');
function repoOpenActiveFor({ origin, envClientId, pinnedClientId }) {
    return V.activation.targets[origin] !== undefined
        && pinnedClientId !== 'UNPINNED' && typeof pinnedClientId === 'string' && pinnedClientId !== ''
        && !PROD.includes(pinnedClientId)
        && envClientId === pinnedClientId;
}
ok(Object.keys(V.activation.targets).length === 1 && V.activation.targets[C.OS_STAGING_ORIGIN]?.worksOrigin === C.WORKS_STAGING_ORIGIN
    && V.activation.targets[C.OS_STAGING_ORIGIN]?.gitHost === C.GIT_STAGING_HOST, 'activation targets');
for (const c of V.activation.cases) {
    eq(repoOpenActiveFor({ origin: c.origin, envClientId: resolveClient(c.envClientId), pinnedClientId: resolveClient(c.pinnedClientId) }), c.active, `activation ${c.name}`);
}
ok(V.activation.cases.some((c) => c.origin === C.OS_STAGING_ORIGIN && PROD.includes(resolveClient(c.envClientId)) && !c.active), 'activation: needs the spoofed-host production-client case');

// ── Works deployment and auth ────────────────────────────────────────────────
function effective(c) { return !c || c === 'UNPINNED' || PROD.includes(c) ? 'UNPINNED' : c; }
function deploymentFor(apiOrigin, pins) {
    if (apiOrigin !== C.WORKS_STAGING_ORIGIN) return { name: 'DEFAULT', v1Clients: [...PROD], osClient: null, gitHost: C.GIT_PRODUCTION_HOST };
    const uni = effective(pins.universe);
    let os = effective(pins.os);
    if (os !== 'UNPINNED' && os === uni) os = 'UNPINNED';
    return { name: 'STAGING', v1Clients: [uni, os].filter((c) => c !== 'UNPINNED'), osClient: os === 'UNPINNED' ? null : os, gitHost: C.GIT_STAGING_HOST };
}
eq(V.works.deployments.DEFAULT.v1Clients, PROD, 'DEFAULT v1Clients equal the frozen production list');
ok(V.works.deployments.DEFAULT.osClient === null && V.works.deployments.DEFAULT.gitHost === C.GIT_PRODUCTION_HOST, 'DEFAULT deployment');
for (const c of V.works.selection) eq(deploymentFor(c.apiOrigin, { os: ids.OS_STAGING, universe: ids.UNIVERSE_STAGING }).name, c.deployment, `selection ${c.apiOrigin}`);
const sym = (id) => Object.keys(ids).find((k) => ids[k] === id) ?? id;
for (const c of V.works.effectivePins) {
    const d = deploymentFor(C.WORKS_STAGING_ORIGIN, { os: resolveClient(c.pins.os), universe: resolveClient(c.pins.universe) });
    eq({ v1Clients: d.v1Clients.map(sym), osClient: d.osClient === null ? null : sym(d.osClient) }, c.expect, `effectivePins ${JSON.stringify(c.pins)}`);
    ok(d.v1Clients.every((x) => !PROD.includes(x)), 'staging v1Clients ∩ production = ∅');
}
const OS_ROUTES = new Set(['os-grant', 'os-revoke']);
const ROUTES_WITH_REF = new Set(['os-grant', 'clone-token', 'freeze', 'push-tests']);
// Reads works.authRule in order: 0 mounting, 1 verify, 2 central OS-token
// refusal, 3 the unchanged middleware (act-as with an EZiL ID bearer), 4 the
// Supabase-bearer path through delegatedRequest, 5 os handlers, 6 refs.
// token 'SUPABASE' is a builder's (non-operator) Supabase bearer: no matched client.
function worksAuth(c) {
    const d = c.deployment === 'DEFAULT'
        ? deploymentFor(null, {})
        : deploymentFor(C.WORKS_STAGING_ORIGIN, { os: resolveClient(c.pins.os), universe: resolveClient(c.pins.universe) });
    const ref = c.ref === null ? null : V.works.refs[c.ref];
    const isOs = OS_ROUTES.has(c.route);
    const mounted = !isOs || d.osClient !== null;
    const refOk = () => !ROUTES_WITH_REF.has(c.route) || (c.route === 'os-grant' ? R.UUID_RE(ref) : R.NUMERIC_REF_RE(ref));
    if (c.token === 'SUPABASE') {
        if (!mounted) return { status: 404, error: 'unmatched_route' };
        if (isOs) return c.actAs === true ? { status: 403, error: 'act_as_operator_required' } : { status: 401, error: 'identity_token_invalid' };
        return refOk() ? { status: 'handler' } : { status: 404, error: 'not_found' };
    }
    const token = resolveClient(c.token);
    if (!d.v1Clients.includes(token)) return { status: 401, error: 'identity_token_invalid' };
    if (!isOs && d.osClient !== null && token === d.osClient) return { status: 401, error: 'identity_token_invalid' };
    if (c.actAs === true) return { status: 403, error: 'ezil_id_delegation_forbidden' };
    if (!mounted) return { status: 404, error: 'unmatched_route' };
    if (isOs && token !== d.osClient) return { status: 401, error: 'identity_token_invalid' };
    return refOk() ? { status: 'handler' } : { status: 404, error: 'not_found' };
}
ok(V.works.authCases.some((c) => c.deployment === 'DEFAULT' && c.actAs === true && OS_ROUTES.has(c.route)), 'works auth: needs a DEFAULT act-as os-route case (V3.7)');
ok(V.works.authCases.some((c) => c.deployment === 'STAGING' && c.pins.os !== 'UNPINNED' && c.pins.os === c.pins.universe && OS_ROUTES.has(c.route)), 'works auth: needs an OS-pin-equals-Universe-pin case');
ok(V.works.authCases.some((c) => c.ref === 'numeric_overflow'), 'works auth: needs a numeric ref above int64 max');
// 1.0.1 (I1 finding 2): DEFAULT os paths answer what an undeclared /v1 path answers, which for a
// non-production EZiL ID client is the middleware's 401, not the unmatched 404.
for (const token of ['OS_STAGING', 'UNIVERSE_STAGING']) for (const route of OS_ROUTES) {
    ok(V.works.authCases.some((c) => c.deployment === 'DEFAULT' && c.token === token && c.route === route && c.actAs !== true && c.expect.status === 401),
        `works auth: needs a DEFAULT ${route} case for a ${token} token (401)`);
}
for (const c of V.works.authCases) eq(worksAuth(c), c.expect, `works auth ${c.deployment} ${c.token} ${c.route} ${c.ref}`);
const osGrantRequestValid = (b) => b && typeof b === 'object' && !Array.isArray(b)
    && Object.keys(b).length === 1 && R.COMPUTER_LABEL_RE(b.computerLabel) && JSON.stringify(b).length <= C.BODY_LIMITS_BYTES.worksOsGrantRequest;
for (const b of V.works.osGrantRequest.valid) ok(osGrantRequestValid(b), `os-grant request valid ${JSON.stringify(b)}`);
for (const b of V.works.osGrantRequest.invalid) ok(!osGrantRequestValid(b), `os-grant request invalid ${JSON.stringify(b)}`);
const osRevokeRequestValid = (b) => b && typeof b === 'object' && !Array.isArray(b)
    && Object.keys(b).every((k) => k === 'computerLabel') && (b.computerLabel === undefined || R.COMPUTER_LABEL_RE(b.computerLabel));
for (const b of V.works.osRevokeRequest.valid) ok(osRevokeRequestValid(b), `revoke request valid ${JSON.stringify(b)}`);
for (const b of V.works.osRevokeRequest.invalid) ok(!osRevokeRequestValid(b), `revoke request invalid ${JSON.stringify(b)}`);
const T = V.timeouts;
for (const c of V.works.osSession.cases) {
    const reuse = c.existing !== null && !c.existing.revoked && c.existing.sameLabel && c.existing.remainingMs > T.OS_SESSION_MIN_REMAINING_MS;
    eq(reuse ? 'reuse' : 'insert', c.expect, `osSession ${JSON.stringify(c.existing)}`);
}
const label = `${C.OS_SESSION_DEVICE_LABEL_PREFIX}${'0'.repeat(C.COMPUTER_LABEL_HEX_CHARS)}`;
ok(label.length <= 80 && C.OS_SESSION_OS.length <= 32 && C.OS_SESSION_CLI_VERSION.length <= 32, 'cli_sessions column widths');

// ── OS grant response validation ─────────────────────────────────────────────
const NOW = V.fixtures.nowMs;
const iso = (v) => (v && typeof v === 'object' && 'relativeSeconds' in v) ? new Date(NOW + v.relativeSeconds * 1000).toISOString() : v;
function materialise(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = (v && typeof v === 'object' && !('relativeSeconds' in v)) ? materialise(v) : expand(iso(v));
    return out;
}
function mutate(base, m, grantKey) {
    const copy = structuredClone(base);
    if (m.set) Object.assign(copy, m.set);
    if (m.setGrant) Object.assign(copy[grantKey], m.setGrant);
    if (m.delete) delete copy[m.delete];
    return materialise(copy);
}
const isoMs = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(s)) ? Date.parse(s) : NaN;
function osGrantResponseValid(r, { repoId, gitHost, now }) {
    const keys = V.works.osGrantResponse.keys;
    if (!r || Object.keys(r).length !== keys.length || !keys.every((k) => Object.hasOwn(r, k))) return false;
    const t = isoMs(r.expiresAt);
    return r.username === C.GRANT_USERNAME && R.GRANT_RE(r.token) && r.repositoryId === repoId
        && R.HANDLE_RE(r.handle) && R.NAME_RE(r.name) && r.routeName === `${r.handle}/${r.name}`
        && r.cloneUrl === `https://${gitHost}/${r.routeName}.git`
        && t > now && t <= now + T.GRANT_TTL_MS + T.OS_ACCEPT_EXPIRY_SLACK_MS
        && C.GRANT_SCOPES.includes(r.scope) && R.BRANCH_RE(r.defaultBranch);
}
const ctx = { repoId: V.fixtures.repositoryId, gitHost: C.GIT_STAGING_HOST, now: NOW };
ok(osGrantResponseValid(materialise(V.works.osGrantResponse.base), ctx), 'os-grant response base valid');
for (const m of V.works.osGrantResponse.validMutations) ok(osGrantResponseValid(mutate(V.works.osGrantResponse.base, m), ctx), `os-grant response valid ${JSON.stringify(m)}`);
for (const m of V.works.osGrantResponse.invalidMutations) ok(!osGrantResponseValid(mutate(V.works.osGrantResponse.base, m), ctx), `os-grant response invalid (${m.why})`);

// ── OS route body ────────────────────────────────────────────────────────────
function osRouteBodyValid(b) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    if (Buffer.byteLength(JSON.stringify(b)) > C.BODY_LIMITS_BYTES.osRouteRequest) return false;
    const allowed = ['op', 'computerId', 'projectId', 'repoId', 'path'];
    if (!Object.keys(b).every((k) => allowed.includes(k))) return false;
    if (!['open', 'refresh'].includes(b.op)) return false;
    if (!R.UUID_RE(b.computerId) || !R.UUID_RE(b.projectId) || !R.UUID_RE(b.repoId)) return false;
    if (b.path !== undefined && (b.op !== 'open' || !pathOk(b.path))) return false;
    return true;
}
for (const b of V.osRoute.request.valid) ok(osRouteBodyValid(b), `os route body valid ${JSON.stringify(b)}`);
for (const b of V.osRoute.request.invalid) ok(!osRouteBodyValid(b), `os route body invalid ${JSON.stringify(b)}`);

// ── Worker request body ──────────────────────────────────────────────────────
function workerBodyValid(b, now) {
    const W = V.workerRequest;
    if (!b || typeof b !== 'object') return false;
    // 1.0.3 (workerRequest.classRule): optionalKeys may be present; class absent = the default class.
    const keys = Object.keys(b).filter((k) => !W.optionalKeys.includes(k));
    if (keys.length !== W.keys.length || !W.keys.every((k) => Object.hasOwn(b, k))) return false;
    const cls = Object.hasOwn(b, 'class') ? b.class : C.REPO_OPEN_CLASS_DEFAULT;
    if (typeof cls !== 'string' || !C.REPO_OPEN_CLASSES.includes(cls) || b.gitHost !== C.REPO_OPEN_CLASS_GIT_HOSTS[cls]) return false;
    if (Buffer.byteLength(JSON.stringify(b)) > C.BODY_LIMITS_BYTES.workerRequest) return false;
    const g = b.grant;
    if (!g || Object.keys(g).length !== W.grantKeys.length || !W.grantKeys.every((k) => Object.hasOwn(g, k))) return false;
    const t = isoMs(g.expiresAt);
    return b.v === 1 && ['open', 'refresh'].includes(b.op) && R.UUID_RE(b.repositoryId) && R.HANDLE_RE(b.handle) && R.NAME_RE(b.name)
        && (cls !== C.REPO_OPEN_CLASS_DEFAULT || W.gitHostAllowList.includes(b.gitHost)) && R.BRANCH_RE(b.defaultBranch)
        && (b.path === null || (b.op === 'open' && pathOk(b.path)))
        && g.username === C.GRANT_USERNAME && R.GRANT_RE(g.token) && C.GRANT_SCOPES.includes(g.scope)
        && t > now && t <= now + T.WORKER_ACCEPT_EXPIRY_MAX_MS;
}
eq(V.workerRequest.gitHostAllowList, [C.GIT_STAGING_HOST], 'worker gitHost allow-list');
eq(V.workerRequest.gitHostAllowList, [C.REPO_OPEN_CLASS_GIT_HOSTS[C.REPO_OPEN_CLASS_DEFAULT]], 'worker gitHost allow-list is the class-absent list');
eq(V.workerRequest.optionalKeys, ['class'], 'worker body optional keys');
eq(V.kernel.optionalRequestKeys, V.workerRequest.optionalKeys, 'the kernel request carries the same optional key');
ok(V.kernel.optionalRequestKeys.every((k) => !V.kernel.requestKeys.includes(k) && !V.kernel.testSeamKeys.includes(k)), 'optional request keys are neither request keys nor test-seam keys');
for (const [cls, host] of Object.entries(C.REPO_OPEN_CLASS_GIT_HOSTS)) {
    for (const other of Object.values(C.REPO_OPEN_CLASS_GIT_HOSTS)) {
        const b = { ...materialise(V.workerRequest.base), class: cls, gitHost: other };
        eq(workerBodyValid(b, NOW), other === host, `worker body class ${cls} on ${other}`);
    }
}
ok(workerBodyValid(materialise(V.workerRequest.base), NOW), 'worker body base valid');
for (const m of V.workerRequest.validMutations) ok(workerBodyValid(mutate(V.workerRequest.base, m, 'grant'), NOW), `worker body valid ${JSON.stringify(m)}`);
for (const m of V.workerRequest.invalidMutations) ok(!workerBodyValid(mutate(V.workerRequest.base, m, 'grant'), NOW), `worker body invalid (${m.why})`);

// ── signature ────────────────────────────────────────────────────────────────
{
    const S = V.signature;
    const body = expand(S.body);
    ok(workerBodyValid(JSON.parse(body), Date.parse('2026-10-31T12:05:00.000Z')), 'signature body is itself a valid Worker body');
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
    eq(bodyHash, S.expectBodySha256, 'signature body sha256');
    const sign = (route) => `t=${S.timestampMs},v1=${createHmac('sha256', S.secret).update(`${S.timestampMs}.POST./sandbox/${S.sandboxName}/${route}.${bodyHash}`).digest('hex')}`;
    eq(sign('repo-open'), S.expectHeader, 'signature header');
    eq(sign('ai-credential'), S.replayedAiCredentialHeader, 'ai-credential header');
    ok(S.expectHeader !== S.replayedAiCredentialHeader && S.replayExpect === 'refused', 'an ai-credential signature never verifies on repo-open');
    ok(R.SANDBOX_NAME_RE(S.sandboxName), 'signature sandbox name');
}

// ── computer label ───────────────────────────────────────────────────────────
for (const c of V.computerLabel) {
    const got = createHash('sha256').update(C.COMPUTER_LABEL_PREFIX + c.computerId).digest('hex').slice(0, C.COMPUTER_LABEL_HEX_CHARS);
    eq(got, c.label, `computerLabel ${c.computerId}`);
    ok(R.COMPUTER_LABEL_RE(got), 'computer label shape');
}

// ── cookie seal ──────────────────────────────────────────────────────────────
{
    const K = V.cookie;
    const keyFor = (ikm) => Buffer.from(hkdfSync(C.COOKIE_HKDF_HASH, ikm, C.COOKIE_HKDF_SALT, C.COOKIE_HKDF_INFO, 32));
    eq(keyFor(K.ikm).toString('hex'), K.expectKeyHex, 'cookie HKDF key');
    const iv = Buffer.from(K.ivHex, 'hex');
    const c = createCipheriv('aes-256-gcm', keyFor(K.ikm), iv); c.setAAD(Buffer.from(C.COOKIE_AAD));
    const sealed = Buffer.concat([iv, c.update(K.plaintext, 'utf8'), c.final(), c.getAuthTag()]).toString('base64url');
    eq(sealed, K.expectValue, 'cookie seal');
    function open(value, ikm) {
        try {
            const buf = Buffer.from(value, 'base64url');
            const d = createDecipheriv('aes-256-gcm', keyFor(ikm), buf.subarray(0, 12));
            d.setAAD(Buffer.from(C.COOKIE_AAD)); d.setAuthTag(buf.subarray(buf.length - 16));
            return JSON.parse(Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]).toString('utf8'));
        } catch { return null; }
    }
    function useCheck(value, ikm, session, nowS) {
        const p = open(value, ikm);
        return p && p.v === C.COOKIE_PLAINTEXT_VERSION && p.uid === session.uid && p.sub === session.auth0Sub
            && typeof p.exp === 'number' && p.exp - nowS >= C.COOKIE_MIN_USE_REMAINING_S ? 'ok' : 'reauth_required';
    }
    for (const u of K.useChecks) {
        let value = K.expectValue;
        if (u.tamperByte !== undefined) { const b = Buffer.from(value, 'base64url'); b[u.tamperByte] ^= 1; value = b.toString('base64url'); }
        eq(useCheck(value, u.ikm ?? K.ikm, u.session, u.nowS), u.expect, `cookie use ${u.case}`);
    }
    for (const m of K.maxAge) {
        const got = m.expMinusNowS < C.COOKIE_MIN_SET_REMAINING_S ? null : Math.min(m.expMinusNowS, C.COOKIE_MAX_AGE_S);
        eq(got, m.expectMaxAgeS, `cookie Max-Age for exp-now=${m.expMinusNowS}`);
    }
    ok(C.COOKIE_NAME.startsWith('__Host-') && /Secure/.test(C.COOKIE_ATTRIBUTES) && /Path=\//.test(C.COOKIE_ATTRIBUTES) && !/Domain=/i.test(C.COOKIE_ATTRIBUTES), 'cookie __Host- attributes');
}

// ── withCodeFolder ───────────────────────────────────────────────────────────
const awsHost = new RegExp(V.regex.AWS_CODE_HOST_RE.source);
function withCodeFolder(minted, openFolder) {
    const url = new URL(minted);
    if (awsHost.test(url.hostname) && url.pathname === '/preview-bootstrap') url.searchParams.set('path', `/?folder=${encodeURIComponent(openFolder)}`);
    else url.searchParams.set('folder', openFolder);
    return url;
}
for (const c of V.withCodeFolder.cases) {
    const url = withCodeFolder(c.input, c.openFolder);
    eq([...url.searchParams.entries()], c.expectParams, `withCodeFolder ${c.input}`);
    eq(awsHost.test(url.hostname) && url.pathname === '/preview-bootstrap' ? 'aws' : 'cloudflare', c.shape, `withCodeFolder shape ${c.input}`);
    if (c.expectFolderAfterBootstrap !== undefined) {
        const rawPath = url.searchParams.get('path') || '/';
        const dest = new URL(rawPath.startsWith('/') && !rawPath.startsWith('//') ? rawPath : '/', url);
        eq(dest.searchParams.get('folder'), c.expectFolderAfterBootstrap, `AWS bootstrap round trip ${c.input}`);
        ok(dest.origin === url.origin, 'AWS bootstrap stays same-origin');
    }
}

// ── reauth URL ───────────────────────────────────────────────────────────────
eq(`${C.REAUTH_PATH}?${C.REAUTH_PARAM}=${encodeURIComponent(V.shell.reauthUrlExample.current)}`, V.shell.reauthUrlExample.expect, 'reauth URL');
ok(!V.shell.reauthUrlExample.expect.includes(C.REAUTH_FORBIDDEN_PARAM), 'reauth URL never uses returnTo');

// ── timeouts ─────────────────────────────────────────────────────────────────
const evalT = (expr) => expr.split(/\s*([+-])\s*/).reduce((acc, tok, i, arr) => {
    if (i === 0) return T[tok];
    if (tok === '+' || tok === '-') return acc;
    return arr[i - 1] === '+' ? acc + T[tok] : acc - T[tok];
}, 0);
for (const chain of T.strictChains) {
    for (const name of chain) ok(Number.isInteger(T[name]) && T[name] > 0, `timeouts: ${name}`);
    for (let i = 1; i < chain.length; i += 1) ok(T[chain[i - 1]] < T[chain[i]], `timeouts: ${chain[i - 1]} < ${chain[i]}`);
}
for (const [left, right] of T.equalities) ok(evalT(left) === evalT(right), `timeouts: ${left} = ${right}`);
for (const [left, right] of T.lessThan) ok(evalT(left) < evalT(right), `timeouts: ${left} < ${right}`);
ok(T.WAKE_DELAYS_MS.every((d, i, a) => i === 0 || a[i - 1] <= d) && T.WAKE_DELAYS_MS.at(-1) === T.WAKE_REPEAT_DELAY_MS, 'wake delays');
ok(T.GRANT_TTL_MS === 15 * 60_000, 'grant TTL is the Works GIT_GRANT_MAX_MS (15 min)');
ok(T.SIGNOUT_BUDGET_MS === 3000, 'signout budget');

// ── repository budget (tar bytes) ────────────────────────────────────────────
const maxBytes = Math.floor(C.SNAPSHOT_LIMIT_BYTES * C.REPO_BUDGET_FRACTION);
const maxEntries = Math.floor(C.SNAPSHOT_MAX_ENTRIES * C.REPO_BUDGET_FRACTION);
ok(C.TAR_BLOCK_BYTES === 512 && C.TAR_ARCHIVE_TAIL_BYTES === 2 * 512 + 20 * 512, 'tar constants: 512-byte blocks; tail = 2 end blocks + one 10240-byte record');
function entryTarBytes(e) {
    const B = C.TAR_BLOCK_BYTES;
    const name = expand(e.name), link = e.linkname === undefined ? '' : expand(e.linkname);
    const nameBytes = Buffer.byteLength(name, 'utf8'), linkBytes = Buffer.byteLength(link, 'utf8');
    const ascii = (s) => /^[\x00-\x7f]*$/.test(s);
    const pax = nameBytes >= C.TAR_PAX_NAME_BYTES || linkBytes >= C.TAR_PAX_NAME_BYTES || !ascii(name) || !ascii(link)
        ? B + B * Math.ceil((nameBytes + linkBytes + C.TAR_PAX_RECORD_SLACK_BYTES) / B) : 0;
    return B + (e.type === 'file' ? B * Math.ceil(e.size / B) : 0) + pax;
}
const budgetOk = (wsBytes, stBytes, wsEntries, stEntries) => wsBytes + stBytes + C.TAR_ARCHIVE_TAIL_BYTES <= maxBytes && wsEntries + stEntries <= maxEntries;
for (const e of V.repoBudget.entryBytes) {
    ok(['file', 'dir', 'symlink'].includes(e.type), `repoBudget entry type ${e.type}`);
    eq(entryTarBytes(e), e.expect, `repoBudget entry ${e.type} ${expand(e.name).slice(0, 40)}`);
}
{
    const K = V.repoBudget.composite;
    const folder = C.REPO_DIR_TEMPLATE.replace('<handle>', V.fixtures.handle).replace('<name>', V.fixtures.name);
    for (const e of K.workspace) ok(e.name !== C.STAGING_ROOT_NAME && !e.name.startsWith(`${C.STAGING_ROOT_NAME}/`), 'repoBudget: the staging subtree is never counted on the workspace side');
    for (const e of K.staged) ok(e.name === folder || e.name.startsWith(`${folder}/`), `repoBudget: staged entry ${e.name} not measured under its final name`);
    const all = [...K.workspace, ...K.staged, ...K.newParentDirs.map((name) => ({ type: 'dir', name, size: 0 }))];
    const bytes = all.reduce((sum, e) => sum + entryTarBytes(e), 0) + C.TAR_ARCHIVE_TAIL_BYTES;
    eq(bytes, K.expectTarBytes, 'repoBudget composite tar bytes');
    eq(all.length, K.expectEntries, 'repoBudget composite entries');
    eq(bytes <= maxBytes && all.length <= maxEntries, K.expectOk, 'repoBudget composite verdict');
}
for (const c of V.repoBudget.cases) {
    eq(budgetOk(c.workspaceTarBytes, c.stagedTarBytes, c.workspaceEntries, c.stagedEntries), c.ok, `repoBudget ${JSON.stringify(c).slice(0, 120)}`);
}
ok(V.repoBudget.cases.some((c) => c.ok && c.workspaceTarBytes + c.stagedTarBytes + C.TAR_ARCHIVE_TAIL_BYTES === maxBytes), 'repoBudget: needs an exactly-at-limit case');
ok(C.STAGING_DIR_TEMPLATE === `${C.STAGING_ROOT_NAME}/<uuid>` && !C.STAGING_ROOT_NAME.includes('/'), 'staging dir is one top-level reserved name');

// 1.0.2 (D5, D6): the workspace side counts exactly what the codec archives (repoBudget.workspaceRule),
// and only repo-open folders (repoOpenMarkerRule) have their nested index read.
{
    const RB = V.repoBudget;
    eq(C.SNAPSHOT_CACHE_NAMES, ['node_modules', '.next', '.turbo', 'dist'], 'SNAPSHOT_CACHE_NAMES (the codec CACHES set)');
    eq(C.SNAPSHOT_INTERNAL_NAMES, ['.ezil-hydrated.json', '.ezil-flush-manifest.json'], 'SNAPSHOT_INTERNAL_NAMES (the codec INTERNAL set)');
    ok(Number.isInteger(C.SNAPSHOT_NESTED_INDEX_MAX) && C.SNAPSHOT_NESTED_INDEX_MAX > 0, 'SNAPSHOT_NESTED_INDEX_MAX');
    ok(C.BINDING_FILE === '.git/ezil-repo.json', 'the repo-open marker is the kernel binding file');
    ok(!/caches and skipped names included/.test(RB.rule), 'repoBudget.rule no longer counts caches and skipped names');
    const normalise = (p) => {
        const out = [];
        for (const seg of p.split('/')) {
            if (seg === '' || seg === '.') continue;
            if (seg === '..' && out.length && out.at(-1) !== '..') out.pop(); else out.push(seg);
        }
        return out.join('/') || '.';
    };
    const linkOk = (name, target) => {
        if (!target || target.startsWith('/') || target.includes('\\')) return false;
        const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
        const resolved = normalise(dir ? `${dir}/${target}` : target);
        return resolved !== '..' && !resolved.startsWith('../');
    };
    const marked = (folder, m) => {
        const parts = folder.split('/');
        return parts.length === 3 && parts[0] === 'repos' && !!m && typeof m === 'object' && !Array.isArray(m)
            && m.v === 1 && m.handle === parts[1] && m.name === parts[2];
    };
    function codecArchived(c) {
        const tracked = new Set();
        for (const [folder, paths] of Object.entries(c.indexes)) {
            if (folder !== '' && !marked(folder, c.markers[folder])) continue;
            for (const p of paths) {
                const parts = `${folder ? `${folder}/` : ''}${p}`.split('/');
                for (let i = 1; i <= parts.length; i += 1) tracked.add(parts.slice(0, i).join('/'));
            }
        }
        const skipped = new Set(), kept = [];
        for (const e of [...c.entries].sort((a, b) => a.name.split('/').length - b.name.split('/').length)) {
            const parts = e.name.split('/'), base = parts.at(-1), parent = parts.slice(0, -1).join('/');
            const inGit = parts.includes('.git');
            let skip = parent !== '' && skipped.has(parent);
            if (!skip && parts.length === 1 && (C.SNAPSHOT_INTERNAL_NAMES.includes(base) || base === C.STAGING_ROOT_NAME)) skip = true;
            if (!skip && !inGit) {
                skip = (C.SNAPSHOT_CACHE_NAMES.includes(base) && !tracked.has(e.name)) || e.name.includes('\\')
                    || !['file', 'dir', 'symlink'].includes(e.type) || (e.type === 'symlink' && !linkOk(e.name, e.linkname));
            }
            if (skip) skipped.add(e.name); else kept.push(e);
        }
        return kept;
    }
    for (const c of RB.workspaceCases) {
        const names = new Set(c.entries.map((e) => e.name));
        ok(names.size === c.entries.length, `workspaceCase ${c.case}: duplicate entry`);
        for (const e of c.entries) {
            ok(['file', 'dir', 'symlink', 'fifo'].includes(e.type), `workspaceCase ${c.case}: entry type ${e.type}`);
            const parent = e.name.split('/').slice(0, -1).join('/');
            ok(parent === '' || c.entries.some((p) => p.name === parent && p.type === 'dir'), `workspaceCase ${c.case}: ${e.name} has no parent directory entry`);
        }
        for (const folder of Object.keys(c.markers)) ok(names.has(`${folder}/${C.BINDING_FILE}`), `workspaceCase ${c.case}: marker ${folder} has no binding file entry`);
        for (const folder of Object.keys(c.indexes)) ok(names.has(folder === '' ? '.git/index' : `${folder}/.git/index`), `workspaceCase ${c.case}: index ${folder || '(root)'} has no .git/index entry`);
        const kept = codecArchived(c);
        eq(kept.map((e) => e.name).sort(), [...c.expectArchived].sort(), `workspaceCase ${c.case}: archived names`);
        const bytes = kept.reduce((sum, e) => sum + entryTarBytes(e), 0);
        eq(bytes, c.expectTarBytes, `workspaceCase ${c.case}: tar bytes`);
        eq(kept.length, c.expectEntries, `workspaceCase ${c.case}: entries`);
        eq(budgetOk(bytes, c.stagedTarBytes, kept.length, c.stagedEntries), c.expectOk, `workspaceCase ${c.case}: verdict`);
    }
    const has = (pred, label) => ok(RB.workspaceCases.some(pred), `workspaceCases need: ${label}`);
    const bigUnder = (c, dir) => c.entries.some((e) => e.type === 'file' && e.size > maxBytes && e.name.split('/').includes(dir));
    has((c) => c.expectOk && bigUnder(c, 'node_modules') && !Object.keys(c.indexes).length, 'an over-budget untracked node_modules that does not count');
    has((c) => !c.expectOk && Object.keys(c.indexes).some((f) => f !== '' && marked(f, c.markers[f])) && bigUnder(c, 'dist'), 'an over-budget tracked dist in a repo-open folder that counts');
    has((c) => c.expectOk && Object.keys(c.indexes).some((f) => f !== '' && !c.markers[f]) && bigUnder(c, 'dist'), 'a tracked dist in an unmarked nested repository that does not count');
    has((c) => Object.keys(c.indexes).includes(''), 'a root index');
    has((c) => Object.values(c.markers).some((m) => m.v !== 1) && Object.entries(c.markers).some(([f, m]) => m.v === 1 && !marked(f, m)), 'invalid bindings (v and name)');
    has((c) => c.entries.some((e) => e.type === 'fifo') && c.entries.some((e) => e.type === 'symlink' && !linkOk(e.name, e.linkname)), 'skipped FIFOs and escaping links');
}

// ── git config, wrapper, grant file ──────────────────────────────────────────
{
    const G = V.gitConfig;
    const url = `https://${G.example.gitHost}/${G.example.handle}/${G.example.name}.git`;
    eq(G.expectLocalList[0], `remote.origin.url=${url}`, 'gitConfig remote url');
    for (const line of G.expectLocalList) for (const bad of G.forbiddenSubstrings) ok(!line.includes(bad), `gitConfig line contains ${bad}`);
    ok(G.expectLocalList.some((l) => l.includes(C.HELPER_WRAPPER_PATH)), 'gitConfig names the fixed wrapper path');
    ok(G.expectLocalList.some((l) => l.includes(C.HELPER_HINT_NOT_CONNECTED)), 'gitConfig carries the not-connected hint');
    // 1.0.1 (I1 finding 1): initialized_empty writes the unborn branch's upstream; push.autosetupremote stays.
    const U = G.branchUpstream;
    ok(R.BRANCH_RE(U.example.branch), 'gitConfig branchUpstream example branch is a BRANCH_RE value');
    eq(U.lines, [`branch.${U.example.branch}.remote=origin`, `branch.${U.example.branch}.merge=refs/heads/${U.example.branch}`], 'gitConfig branchUpstream lines');
    for (const line of U.lines) for (const bad of G.forbiddenSubstrings) ok(!line.includes(bad), `gitConfig branchUpstream line contains ${bad}`);
    ok(U.lines.every((l) => !/^(remote|credential|url|push)\./.test(l) && !G.expectLocalList.includes(l)), 'gitConfig branchUpstream lines are branch.* only');
    eq(Object.keys(U.writtenBy), V.osRoute.openStates, 'gitConfig branchUpstream writtenBy keys are the open states');
    ok(G.expectLocalList.includes('push.autosetupremote=true'), 'gitConfig keeps push.autosetupremote=true');
    ok(/\bgit push\.?$/.test(V.shell.notices.initialized_empty), 'shell.notices.initialized_empty ends with a plain git push');
    ok(V.helperWrapper.path === C.HELPER_WRAPPER_PATH && V.helperWrapper.lines.join('\n').includes(C.HELPER_MODULE_PATH), 'wrapper paths');
    const gf = V.grantFile.example;
    eq(Object.keys(gf), V.grantFile.keys, 'grant file keys');
    ok(R.GRANT_RE(expand(gf.password)) && gf.host === C.GIT_STAGING_HOST && !gf.path.startsWith('/') && gf.path === `${V.fixtures.handle}/${V.fixtures.name}.git`, 'grant file example');
    ok(V.grantFile.pathExample === C.GRANT_FILE_TEMPLATE.replace('<handle>', V.fixtures.handle).replace('<name>', V.fixtures.name), 'grant file path');
}

// ── error table ──────────────────────────────────────────────────────────────
{
    const E = V.errorTable;
    const codes = Object.keys(E.codes);
    for (const [code, row] of Object.entries(E.codes)) {
        ok(Number.isInteger(row.http) && row.http >= 400 && row.http < 600, `errorTable ${code}: http`);
        ok(Object.hasOwn(E.retryableFlag, row.retry), `errorTable ${code}: retry ${row.retry}`);
        ok(Object.hasOwn(E.copy, row.copyKey), `errorTable ${code}: copy key ${row.copyKey}`);
    }
    for (const [key, value] of Object.entries(E.copy)) {
        ok(codes.some((c) => E.codes[c].copyKey === key), `copy ${key} is unused`);
        ok(value === null ? ['signin', 'silent'].includes(key) : typeof value === 'string' && value.length > 0 && !/<[a-z]+>/.test(value), `copy ${key}`);
    }
    const reachable = new Set();
    for (const r of E.osOriginated) { ok(codes.includes(r.errorCode), `osOriginated ${r.errorCode}`); reachable.add(r.errorCode); }
    for (const r of E.upstream) {
        ok(codes.includes(r.errorCode), `upstream ${r.source} ${r.status} ${r.code}: unknown ${r.errorCode}`);
        ok(['works', 'worker', 'transport'].includes(r.source), `upstream source ${r.source}`);
        reachable.add(r.errorCode);
    }
    for (const code of codes) ok(reachable.has(code), `errorTable ${code} is unreachable`);
    for (const code of C.WAKE_RETRY_ERROR_CODES) ok(E.codes[code]?.retry === 'wake_loop', `wake retry ${code}`);
    for (const code of codes) if (E.codes[code].retry === 'wake_loop') ok(C.WAKE_RETRY_ERROR_CODES.includes(code), `wake code ${code} not listed`);
    for (const code of V.kernel.errorCodes) {
        ok(E.upstream.some((r) => r.source === 'worker' && r.code === code), `kernel ${code} has no Worker mapping`);
        ok(E.workerResponses.refusals.some((r) => r.error.includes(code)), `kernel ${code} is not a Worker refusal`);
    }
    for (const r of V.kernel.classification) ok(V.kernel.errorCodes.includes(r.errorCode), `kernel classification ${r.errorCode}`);
    for (const r of E.workerResponses.refusals) for (const err of r.error) {
        ok(E.upstream.some((u) => u.source === 'worker' && u.code === err && u.status === r.status), `worker ${r.status} ${err} unmapped`);
    }
    for (const ws of [400, 401, 409, 500, 502, 'other']) ok(E.upstream.some((u) => u.source === 'worker' && u.status === ws && u.code === '*'), `worker ${ws} has no catch-all`);
    ok(E.upstream.some((u) => u.source === 'worker' && u.status === 200 && u.code === 'invalid body' && u.errorCode === 'workspace_failed'), 'worker 200 invalid body unmapped');
    const seen = new Set();
    for (const u of E.upstream) {
        const key = `${u.source}|${u.status}|${u.code}`;
        ok(!seen.has(key), `upstream row ${key} is duplicated`);
        seen.add(key);
    }
    const W = E.workerResponses;
    eq(W.okOpen.keys, V.kernel.resultOpenKeys, 'Worker open 200 keys equal the kernel open result keys');
    eq(W.okRefresh.keys, V.kernel.resultRefreshKeys, 'Worker refresh 200 keys equal the kernel refresh result keys');
    eq(W.okOpen.states, V.osRoute.openStates, 'Worker open 200 states');
    ok(W.okRefresh.states.every((s) => V.kernel.states.includes(s)) && W.okOpen.states.every((s) => V.kernel.states.includes(s)), 'Worker 200 states are kernel states');
    function workerOkValid(op, b) {
        const shape = op === 'open' ? W.okOpen : W.okRefresh;
        if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
        if (Object.keys(b).length !== shape.keys.length || !shape.keys.every((k) => Object.hasOwn(b, k))) return false;
        if (b.ok !== true || !shape.states.includes(b.state)) return false;
        if (op === 'refresh') return true;
        const abs = (p) => typeof p === 'string' && p.startsWith('/') && !p.split('/').some((seg) => seg === '..' || seg === '.');
        return abs(b.folder) && abs(b.openFolder) && (b.openFolder === b.folder || b.openFolder.startsWith(`${b.folder}/`))
            && typeof b.pathNotFound === 'boolean' && typeof b.empty === 'boolean' && R.BRANCH_RE(b.branch);
    }
    for (const c of W.okCases) eq(workerOkValid(c.op, c.body), c.valid, `Worker 200 ${c.op} ${JSON.stringify(c.body).slice(0, 80)}`);
    // 1.0.3: the assessment open shape (kernel.assessment, okAssessmentRule).
    const K = V.kernel.assessment;
    eq(W.okOpenAssessment.keys, K.resultOpenKeys, 'Worker assessment open 200 keys equal the kernel assessment open keys');
    eq(K.resultOpenKeys, [...V.kernel.resultOpenKeys, 'head', 'clean'], 'the assessment open keys are the personal ones plus head and clean');
    eq(W.okOpenAssessment.states, K.states, 'Worker assessment open 200 states');
    ok(K.states.every((s) => W.okOpen.states.includes(s)) && !K.states.includes('existing'), 'assessment states are open states without existing');
    eq(K.hardenedRead.globalOptions, ['--no-pager', '--no-optional-locks'], 'hardened read global options');
    eq(Object.keys(K.hardenedRead.env), ['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_CEILING_DIRECTORIES', 'GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'], 'hardened read env');
    // core.fsmonitor must be EMPTY: git < 2.36 runs the value `false` as a hook command (review fix).
    ok(K.hardenedRead.env.GIT_CONFIG_GLOBAL === '/dev/null' && K.hardenedRead.config.includes('core.hooksPath=/dev/null')
        && K.hardenedRead.config.includes('core.fsmonitor=') && !K.hardenedRead.config.some((c) => /^core\.fsmonitor=./.test(c)), 'hardened read config (fsmonitor off by the empty value)');
    ok(K.hardenedRead.env.GIT_CEILING_DIRECTORIES === `<root>/${C.STAGING_ROOT_NAME}`, 'the hardened reads run in staging, before the rename (ceiling = the staging root)');
    ok(Number.isSafeInteger(K.readBudgetMs) && K.readBudgetMs > 0 && K.readBudgetMs < V.timeouts.COMMIT_EXEC_MAX_MS, 'assessment readBudgetMs is inside the commit exec window');
    ok(V.kernel.classification.some((c) => /class assessment/.test(c.cause) && /defaultBranch/.test(c.cause) && c.errorCode === 'repository_unavailable'), 'an assessment remote without defaultBranch is classified');
    ok(typeof K.trust === 'string' && /evidence, not proof/.test(K.trust), 'assessment head and clean are stated as in-guest evidence');
    const HEX40 = /^[0-9a-f]{40}$/;
    function assessmentOkValid(b) {
        const shape = W.okOpenAssessment;
        if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
        if (Object.keys(b).length !== shape.keys.length || !shape.keys.every((k) => Object.hasOwn(b, k))) return false;
        if (b.ok !== true || !shape.states.includes(b.state)) return false;
        const abs = (p) => typeof p === 'string' && p.startsWith('/') && !p.split('/').some((seg) => seg === '..' || seg === '.');
        return abs(b.folder) && abs(b.openFolder) && (b.openFolder === b.folder || b.openFolder.startsWith(`${b.folder}/`))
            && typeof b.pathNotFound === 'boolean' && typeof b.empty === 'boolean' && R.BRANCH_RE(b.branch)
            && (b.head === null || (typeof b.head === 'string' && HEX40.test(b.head))) && typeof b.clean === 'boolean'
            && b.empty === (b.head === null) && (b.state === 'initialized_empty') === (b.head === null);
    }
    const assessmentCases = W.okAssessmentCases.map((c) => ({ ...c, body: Object.fromEntries(Object.entries(c.body).map(([k, v]) => [k, expand(v)])) }));
    for (const c of assessmentCases) eq(assessmentOkValid(c.body), c.valid, `Worker assessment 200 ${c.why ?? 'valid'} ${JSON.stringify(c.body).slice(0, 60)}`);
    for (const valid of [true, false]) ok(assessmentCases.some((c) => c.valid === valid), `Worker assessment 200 needs a ${valid ? 'valid' : 'invalid'} case`);
    for (const c of assessmentCases) if (c.valid) ok(!workerOkValid('open', c.body), 'an assessment-shaped 200 is invalid for a personal open');
    for (const c of W.okCases) if (c.op === 'open' && c.valid) ok(!assessmentOkValid(c.body), 'a personal-shaped 200 is invalid for an assessment open');
    for (const op of ['open', 'refresh']) for (const valid of [true, false]) ok(W.okCases.some((c) => c.op === op && c.valid === valid), `Worker 200 needs a ${valid ? 'valid' : 'invalid'} ${op} case`);
    for (const ws of [401, 403, 404, 409, 422, 429, '5xx', '3xx', 'other']) ok(E.upstream.some((u) => u.source === 'works' && u.status === ws && u.code === '*'), `works ${ws} has no catch-all`);
    for (const code of ['identity_conflict', 'identity_unverified', 'ezil_id_builders_only', 'account_suspended', 'repository_not_ready']) {
        ok(E.upstream.some((u) => u.source === 'works' && u.code === code), `works code ${code} unmapped`);
    }
    ok(!Object.values(E.copy).some((v) => typeof v === 'string' && /egg_|eyJ|Works said|stack/i.test(v)), 'copy carries no upstream text');
    eq(V.osRoute.refusalKeys, ['ok', 'errorCode', 'retryable'], 'refusal body keys');
}

// ── gateway authorize ────────────────────────────────────────────────────────
{
    const G = V.gitAuthorize;
    eq(Object.keys(G.denyStatus).sort(), [...G.denyReasons].sort(), 'deny reasons and statuses');
    // Reference authorizer: the order of EZiL-Works 7974ab6c cli.ts:258-277 and
    // cli-auth.ts:323-338. checkOrder in the vectors must name exactly these steps.
    const ORDER = ['grant row (invalid)', 'grant revoked', 'session revoked or session expired', 'grant expired', 'route repository', 'grant scope', 'account suspended', 'live authority'];
    eq(G.checkOrder, ORDER, 'gitAuthorize checkOrder');
    const DEFAULTS = { grantShape: 'valid', grantKnown: true, grantRevoked: false, sessionRevoked: false, sessionExpired: false, grantExpired: false,
        routeMatches: true, grantMaxScope: 'write', accountSuspended: false, liveScope: 'write', liveReason: null };
    function gitAuthorize(service, partial) {
        for (const k of Object.keys(partial)) ok(Object.hasOwn(DEFAULTS, k), `gitAuthorize: unknown state key ${k}`);
        const s = { ...DEFAULTS, ...partial };
        if (s.grantShape === 'malformed') return { decision: 'gateway_401_no_works_call' };
        const deny = (reason) => ({ decision: 'deny', status: G.denyStatus[reason], reason });
        const needed = service === 'git-receive-pack' ? 'write' : 'read';
        if (!s.grantKnown) return deny('grant_invalid');
        if (s.grantRevoked) return deny('grant_revoked');
        if (s.sessionRevoked || s.sessionExpired) return deny('session_revoked');
        if (s.grantExpired) return deny('grant_expired');
        if (!s.routeMatches) return deny('repository_not_found');
        if (needed === 'write' && s.grantMaxScope !== 'write') return deny('scope_read_only');
        if (s.accountSuspended) return deny('account_suspended');
        if (!s.liveScope) return deny(s.liveReason === 'repository_access_denied' ? 'repo_not_selected' : 'authority_lapsed');
        if (needed === 'write' && s.liveScope !== 'write') return deny('authority_lapsed');
        return { decision: 'allow' };
    }
    for (const c of G.cases) {
        ok(['git-upload-pack', 'git-receive-pack'].includes(c.service) && c.state && typeof c.state === 'object', `gitAuthorize ${c.case}: service and state`);
        eq(gitAuthorize(c.service, c.state ?? {}), c.expect, `gitAuthorize ${c.case}`);
        if (c.expect.decision !== 'deny') continue;
        ok(G.denyReasons.includes(c.expect.reason), `gitAuthorize ${c.case}: unknown reason`);
        eq(c.expect.status, G.denyStatus[c.expect.reason], `gitAuthorize ${c.case}: status`);
        const kernelCode = c.expect.status === 404 ? 'repository_unavailable' : 'git_auth_rejected';
        ok(V.kernel.classification.some((k) => k.cause === `gateway HTTP ${c.expect.status}` && k.errorCode === kernelCode), `gitAuthorize ${c.case}: kernel classification`);
    }
    for (const reason of G.denyReasons) ok(G.cases.some((c) => c.expect.reason === reason), `gitAuthorize needs a ${reason} case`);
}

// ── board / shell odds and ends ──────────────────────────────────────────────
ok(V.osRoute.openStates.every((s) => V.kernel.states.includes(s)), 'open states are kernel states');
for (const key of ['deadlineMs', 'staging', 'uuid', 'inflight']) ok(V.kernel.requestKeys.includes(key), `kernel request carries ${key}`);
ok(V.kernel.testSeamKeys.length > 0 && V.kernel.testSeamKeys.every((k) => !V.kernel.requestKeys.includes(k)), 'kernel test seam keys are never request keys (the CLI entry refuses them)');
eq(Object.keys(V.kernel.phases), ['prepare', 'commit', 'refresh', 'release'], 'kernel phases');
ok(C.LOCK_OWNER_TEMPLATE === `${C.LOCK_TEMPLATE}/owner`, 'lock owner file lives in the lock dir');
ok(Number.isInteger(T.LOCK_STALE_MS) && T.LOCK_STALE_MS > T.WORKER_DEADLINE_MS, 'LOCK_STALE_MS is only a backstop beyond one Worker deadline');

// ── production OS pin gate (1.0.2, D1) ───────────────────────────────────────
{
    const P = V.productionOs;
    const symbols = { ...V.fixtures.clientIds, ...Object.fromEntries(Object.entries(P.placeholderClientIds).filter(([k]) => k !== 'about')) };
    for (const [k, v] of Object.entries(P.placeholderClientIds)) {
        if (k !== 'about') ok(!/^[A-Za-z0-9]{32}$/.test(v) && !PROD.includes(v), `productionOs placeholder ${k} must not look like an Auth0 client id`);
    }
    const id = (s) => (s === 'UNPINNED' || s === '' ? s : symbols[s]);
    function pinGate({ os, universe, read }) {
        const o = id(os), u = id(universe), r = read.map(id);
        if (r.length === 0) return 'production_clients_unread';
        if (!o || o === 'UNPINNED' || !u || u === 'UNPINNED') return 'pin_ineffective';
        const production = new Set([...PROD, ...r]);
        if (production.has(o) || production.has(u)) return 'pin_is_production';
        if (o === u) return 'pins_equal';
        if (r.some((c) => !PROD.includes(c))) return 'production_client_unlisted';
        return 'pin';
    }
    for (const c of P.pinGateCases) {
        for (const s of [c.os, c.universe, ...c.read]) ok(s === 'UNPINNED' || s === '' || Object.hasOwn(symbols, s), `pinGate ${c.case}: unknown symbol ${s}`);
        eq(pinGate(c), c.expect, `pinGate ${c.case}`);
    }
    for (const outcome of P.pinGateOrder) ok(P.pinGateCases.some((c) => c.expect === outcome), `pinGate needs a ${outcome} case`);
    ok(P.pinGateCases.some((c) => c.expect === 'pin_is_production' && c.os === c.read[0] && !Object.hasOwn(V.fixtures.clientIds, c.os)),
        'pinGate needs an OS pin equal to an unlisted production OS client (the finding the gate exists for)');
}

// ── Worker exec timeouts, route gate (1.0.2, D7a, D8) ────────────────────────
{
    const W = V.workerExec;
    const timedOut = ({ exitCode, stderr, elapsedMs, timeoutMs }) => exitCode === 124
        && (elapsedMs >= timeoutMs - 500 || /Command timed out after \d+ms\s*$/.test(stderr));
    for (const c of W.timeoutCases) eq(timedOut(c), c.timedOut, `workerExec timeout ${c.case}`);
    for (const v of [true, false]) ok(W.timeoutCases.some((c) => c.timedOut === v && c.exitCode === 124), `workerExec needs an exit-124 case that is ${v ? '' : 'not '}a timeout`);
    eq(Object.keys(W.timeoutErrorByStep), ['setup', 'prepare', 'commit', 'refresh', 'release'], 'workerExec timeoutErrorByStep steps');
    for (const [step, code] of Object.entries(W.timeoutErrorByStep)) {
        ok(code === 'fallback' ? step === 'release' : V.errorTable.workerResponses.refusals.some((r) => r.error.includes(code)), `workerExec ${step} → ${code}`);
    }
    ok(W.timeoutErrorByStep.prepare === 'workspace_busy' && W.timeoutErrorByStep.commit === 'workspace_busy', 'prepare and commit timeouts are retryable (workspace_busy)');
    // 1.0.3 (review fix): an assessment commit that may have renamed is never retryable.
    const A = W.assessment.timeoutErrorByStep;
    eq(Object.keys(A), Object.keys(W.timeoutErrorByStep), 'workerExec assessment timeoutErrorByStep steps');
    for (const [step, code] of Object.entries(A)) ok(code === (step === 'commit' ? 'workspace_failed' : W.timeoutErrorByStep[step]), `workerExec assessment ${step} → ${code}`);
    ok(V.errorTable.codes.workspace_failed.retry === 'none' && V.errorTable.codes.workspace_busy.retry === 'wake_loop', 'an assessment commit timeout is terminal; busy stays retryable');
    eq(W.postPrepareRecheck.stopped.answer, 'runtime_not_running', 'post-prepare stop answer');
    eq(W.postPrepareRecheck.transition.answer, 'workspace_busy', 'post-prepare transition answer');
    for (const k of ['stopped', 'transition']) ok(C.WAKE_RETRY_ERROR_CODES.includes(V.errorTable.upstream.find((u) => u.source === 'worker' && u.code === W.postPrepareRecheck[k].answer)?.errorCode), `post-prepare ${k} answer is retried by the wake loop`);
    const G = W.routeGate;
    ok(G.stagingValue !== G.productionValue && new URL(G.stagingValue).origin === G.stagingValue && new URL(G.productionValue).origin === G.productionValue, 'routeGate values are distinct bare origins');
    ok(G.unmountedStatus === 404 && G.unmountedBody === JSON.stringify({ ok: false, error: 'not_found' }), 'routeGate unmounted status and body');
}

// ── image inputs (1.0.2, D2) ─────────────────────────────────────────────────
{
    const I = V.imageInputs;
    let workflow = '';
    try { workflow = readFileSync(join(REPO_ROOT, I.workflow), 'utf8'); } catch { workflow = ''; }
    const block = /^ {2}IMAGE_INPUTS: \|-\n((?: {4}\S.*\n)+)/m.exec(workflow)?.[1] ?? '';
    const inputs = block.split('\n').map((l) => l.trim()).filter(Boolean);
    ok(inputs.length > 0 && inputs.includes('worker/scripts'), `${I.workflow}: IMAGE_INPUTS parsed (and still lists worker/scripts)`);
    for (const p of I.repoOpenPaths) {
        const covering = inputs.filter((input) => p === input || p.startsWith(`${input}/`));
        eq(covering, [], `imageInputs: ${p} is under an image input`);
    }
    ok(I.repoOpenPaths.includes(I.generator), 'imageInputs: the generator is a repo-open path');
    // A tree without the u2 Worker half (the AWS assessment carry on the os-staging lineage) has
    // neither the generator nor the module it generates; the check applies once they land.
    const generated = 'worker/src/repo-open-assets.generated.ts';
    if (existsSync(join(REPO_ROOT, generated))) ok(existsSync(join(REPO_ROOT, I.generator)), `imageInputs: ${I.generator} exists`);
    else skipped.push(`imageInputs: ${I.generator} exists (no ${generated} in this tree)`);
    ok(!existsSync(join(REPO_ROOT, I.retiredGenerator)), `imageInputs: ${I.retiredGenerator} is gone (it sat under the worker/scripts image input)`);
}

// ── contract text (1.0.2): the production OS host is os.ezil.work ────────────
{
    let contract = '';
    try { contract = readFileSync(CONTRACT_PATH, 'utf8'); } catch { contract = ''; }
    ok(contract.includes(`contractVersion | \`${V.contractVersion}\``), 'contract header carries the vectors contractVersion');
    ok(!/os\.ezil\.org's `?AUTH0_CLIENT_ID/.test(contract) && !/os\.ezil\.org `\/api\/health`/.test(contract), 'contract still reads os.ezil.org as the production OS app');
    ok(contract.includes('os.ezil.work') && contract.includes('ezil-os-preview'), 'contract names the production OS app (os.ezil.work, ezil-os-preview)');
    ok(!contract.includes(V.imageInputs.retiredGenerator), 'contract still names the retired generator path');
}

// ── gateway extract (EZiL CLI is public: no DB, Supabase or IP hosts) ────────
const GX = V.gatewayExtract;
const gatewayExtract = {
    contract: V.contract,
    contractVersion: V.contractVersion,
    sourceVectorsSha256: sha256,
    about: 'Derived from docs/contracts/universe-repo-open-v1.vectors.json in EZiL-OS by check.mjs --emit-gateway-extract. Never edit; the lead regenerates it with every contract change.',
    constants: Object.fromEntries(GX.constants.map((k) => { ok(Object.hasOwn(C, k), `gateway extract: constant ${k} missing`); return [k, C[k]]; })),
    gatewayForbiddenHosts: GX.forbiddenHosts,
    regex: Object.fromEntries(GX.regex.map((k) => { ok(Object.hasOwn(V.regex, k), `gateway extract: regex ${k} missing`); return [k, V.regex[k]]; })),
};
const gatewayExtractText = `${JSON.stringify(gatewayExtract, null, 2)}\n`;
const gatewayExtractSha256 = createHash('sha256').update(gatewayExtractText, 'utf8').digest('hex');
for (const h of GX.forbiddenHosts) ok(C.STAGING_FORBIDDEN_HOSTS.includes(h), `gateway extract: ${h} is not a staging-forbidden host`);
for (const h of [C.GIT_STAGING_HOST, new URL(C.WORKS_STAGING_ORIGIN).host]) ok(!GX.forbiddenHosts.includes(h), `gateway extract forbids its own preview host ${h}`);
ok(!/sslip\.io|\b\d{1,3}(?:[.-]\d{1,3}){3}\b|"db[.-]|supabase/i.test(gatewayExtractText), 'gateway extract carries a DB, Supabase or IP host');
ok(!gatewayExtractText.includes(C.PREVIEW_SUPABASE_ORIGIN) && !/egg_[0-9a-f]{64}|eyJ/.test(gatewayExtractText), 'gateway extract hygiene');

// ── pins ─────────────────────────────────────────────────────────────────────
let readme = '';
try { readme = readFileSync(README_PATH, 'utf8'); } catch { readme = ''; }
const pinOf = (label) => { const m = new RegExp(`${label}: \`([0-9a-f]{64})\``).exec(readme); return m ? m[1] : null; };
const pinned = pinOf('Pinned vectors sha256');
const pinnedGateway = pinOf('Pinned gateway extract sha256');
ok(pinned !== null, 'README-universe-repo-open.md has no "Pinned vectors sha256: `<hex>`" line');
if (pinned !== null) ok(pinned === sha256, `pinned sha256 ${pinned} differs from the file`);
ok(pinnedGateway !== null, 'README-universe-repo-open.md has no "Pinned gateway extract sha256: `<hex>`" line');
if (pinnedGateway !== null) ok(pinnedGateway === gatewayExtractSha256, `pinned gateway extract sha256 ${pinnedGateway} differs from the derived extract`);

const runtime = typeof globalThis.Bun !== 'undefined' ? `bun ${globalThis.Bun.version}` : `node ${process.versions.node}`;
const status = EMIT_GATEWAY_EXTRACT ? console.error : console.log;
if (failures.length) {
    for (const f of failures) console.error(`FAIL ${f}`);
    console.error(`universe-repo-open-v1 vectors: ${failures.length} of ${checks} checks failed (${runtime})`);
    console.error(`sha256 ${sha256}`);
    console.error(`gateway extract sha256 ${gatewayExtractSha256}`);
    process.exit(1);
}
for (const s of skipped) status(`SKIP ${s}`);
status(`universe-repo-open-v1 vectors ${V.contractVersion}: ${checks} checks passed (${runtime})`);
status(`sha256 ${sha256}`);
status(`gateway extract sha256 ${gatewayExtractSha256}`);
if (EMIT_GATEWAY_EXTRACT) process.stdout.write(gatewayExtractText);
