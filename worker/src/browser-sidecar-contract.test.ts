/**
 * THE PRODUCER SIDE OF THE PINNED WIRE.
 *
 * The sidecar (`worker/sidecar/`, this repo) and the MCP route that drives it
 * (`apps/api/src/routes/mcp/`, EZiL-Works) are built by different agents in
 * different repositories and cannot see each other's code. That is exactly the
 * shape that produced the defect the legacy Universe MCP records in its own
 * contract header: the client posted `{subject, performed_on, minutes,
 * summary}` to one path while the server read `{actor, scopes,
 * arguments:{worked_on, narrative}}` at another. Every tool call would have
 * failed — and the client's suite was entirely green, because it was testing
 * the client against the client's own belief.
 *
 * So neither side describes the wire in prose. Both import ONE file:
 *
 *     EZiL-Works: apps/api/src/routes/mcp/browser-sidecar.contract.json
 *
 * and each asserts its own types against it. This is this side's assertion. A
 * rename in `worker/sidecar/` goes red HERE rather than in production.
 *
 * ── v2 is ADDITIVE, and this file proves it ─────────────────────────────────
 * The JSON still pins v1 (version '1'). `worker/sidecar/contract.mjs` declares
 * v2: every v1 route, member and error code unchanged, plus `V2_ROUTES` and
 * the one new code `origin_read_only`. So this suite asserts CONTAINMENT, not
 * equality: the pinned v1 JSON is inside `SIDECAR_WIRE` route for route and
 * member for member, its codes are inside `ERROR_CODES` with
 * `origin_read_only` the only addition, `SIDECAR_WIRE` is exactly
 * `V1_ROUTES` + `V2_ROUTES`, and the Worker allowlist is exactly the route
 * verbs. A v2 change that edits a v1 member goes red here.
 *
 * ── Why a skip is possible, and why it is loud ──────────────────────────────
 * The contract lives in a sibling checkout. When that checkout is absent this
 * suite CANNOT run, and this repo's convention (contract §10 / the container
 * suites) is that a suite which could not run must never look like a pass.
 * It therefore skips with a banner naming the exact path it wanted, and
 * `EZIL_BROWSER_SIDECAR_CONTRACT` overrides the location.
 *
 * ── M2: the sibling checkout is next to the MAIN tree, not this worktree ───
 * `import.meta.dir/../../..` finds the sibling correctly from the main
 * checkout (`worker/src` -> `worker` -> the repo root -> its parent), but a
 * task worktree lives at `<repo>/.claude/worktrees/<id>`, one level DEEPER —
 * so the same three `..`s land inside `.claude/worktrees/`, never beside the
 * repo, and this suite skipped all 10 tests in every worktree (found by O3;
 * row M2). `tools/worktree.sh` solves the identical problem the identical
 * way: `--git-common-dir` is the one path identical from every worktree (it
 * always names the MAIN checkout's `.git`, worktree or not), so its parent's
 * parent is the sibling-checkout directory regardless of where this file is
 * running from. Falls back to the old relative derivation if git is
 * unavailable for any reason (e.g. this file copied outside a git checkout).
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The MAIN checkout's root, found the same way `tools/worktree.sh` finds
 *  `REPO` — from wherever this file happens to be running, worktree or not.
 *  `null` when git cannot answer (not a git checkout at all). */
function mainRepoRoot (): string | null {
    const res = spawnSync(
        'git', ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        { cwd: import.meta.dir, encoding: 'utf8' },
    );
    if (res.status !== 0 || !res.stdout) return null;
    // `--git-common-dir` names `<repo>/.git` — even when invoked from inside
    // a worktree, it names the MAIN repo's `.git`, never the worktree's own
    // `.git` file. Its dirname is therefore the main checkout root.
    return dirname(res.stdout.trim());
}

const GIT_ROOT = mainRepoRoot();
const DEFAULT_CONTRACT = GIT_ROOT
    ? join(dirname(GIT_ROOT), 'EZiL-Works', 'apps', 'api', 'src', 'routes', 'mcp', 'browser-sidecar.contract.json')
    : join(
        import.meta.dir, '..', '..', '..',
        'EZiL-Works', 'apps', 'api', 'src', 'routes', 'mcp', 'browser-sidecar.contract.json',
    );
const EXPLICIT_CONTRACT = process.env.EZIL_BROWSER_SIDECAR_CONTRACT;
const CONTRACT_PATH = EXPLICIT_CONTRACT ?? DEFAULT_CONTRACT;
const HAVE_CONTRACT = existsSync(CONTRACT_PATH);

// A path someone NAMED that is not there is a broken run, not an absent
// sibling checkout: it fails instead of skipping.
if (EXPLICIT_CONTRACT !== undefined && !HAVE_CONTRACT) {
    describe('worker/sidecar conforms to the pinned wire contract', () => {
        it('EZIL_BROWSER_SIDECAR_CONTRACT names a file that exists', () => {
            expect({ EZIL_BROWSER_SIDECAR_CONTRACT: EXPLICIT_CONTRACT, exists: false })
                .toEqual({ EZIL_BROWSER_SIDECAR_CONTRACT: EXPLICIT_CONTRACT, exists: true });
        });
    });
}

if (!HAVE_CONTRACT) {
    console.warn(
        `\n⚠️  browser-sidecar contract NOT CHECKED — the pinned wire was not found at:\n`
        + `      ${CONTRACT_PATH}\n`
        + `    This is a SKIP, not a pass: nothing below has compared worker/sidecar to the\n`
        + `    contract the MCP route in EZiL-Works reads. Check that repo out beside this\n`
        + `    one, or set EZIL_BROWSER_SIDECAR_CONTRACT to the file.\n`,
    );
}

interface PinnedContract {
    version: string;
    transport: { port: number; bind: string; method: string; not_through: string };
    forbidden: { cdp_passthrough: string[] };
    redaction: { rule: string; applies_to: string[]; proof_required: string };
    verbs: Record<string, { request?: Record<string, string>; response?: Record<string, string> }>;
    errors: { shape: Record<string, unknown>; codes: string[] };
}

const pinned: PinnedContract | null = HAVE_CONTRACT
    ? (JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as PinnedContract)
    : null;

/** `"boolean?"` / `"string?"` means optional; anything else is required. */
function requiredMembers (block: Record<string, string> | undefined): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const [name, type] of Object.entries(block ?? {})) {
        if (name.startsWith('$')) continue;
        out[name] = !type.endsWith('?');
    }
    return out;
}

function responseMembers (block: Record<string, string> | undefined): string[] {
    return Object.keys(block ?? {}).filter((k) => !k.startsWith('$')).sort();
}

const describeIf = HAVE_CONTRACT ? describe : describe.skip;

type Wire = Record<string, { request: Record<string, boolean>; response: string[] }>;

/** `"POST /fill_form"` -> `"fill_form"`. */
const verbOf = (route: string): string => route.split(' /')[1]!;

describeIf('worker/sidecar conforms to the pinned wire contract', () => {
    it('the contract file itself is the version this side was written against', () => {
        expect(pinned!.version).toBe('1');
    });

    it('the pinned v1 JSON names exactly V1_ROUTES', async () => {
        const { V1_ROUTES } = await import('../sidecar/contract.mjs');
        expect(Object.keys(pinned!.verbs).sort()).toEqual([...V1_ROUTES].sort());
        expect(new Set(V1_ROUTES).size).toBe(V1_ROUTES.length);
    });

    it('v2 is additive: SIDECAR_WIRE is exactly V1_ROUTES + V2_ROUTES, and VERBS serves exactly that', async () => {
        const { SIDECAR_WIRE, V1_ROUTES, V2_ROUTES } = await import('../sidecar/contract.mjs');
        const { VERBS } = await import('../sidecar/verbs.mjs');
        const declared = [...V1_ROUTES, ...V2_ROUTES];
        expect(new Set(declared).size).toBe(declared.length);
        expect(V2_ROUTES.filter((r: string) => V1_ROUTES.includes(r))).toEqual([]);
        // Both the declaration AND the live handler map, so a handler that
        // exists without a declaration (or vice versa) cannot hide here.
        expect(Object.keys(SIDECAR_WIRE).sort()).toEqual([...declared].sort());
        expect(Object.keys(VERBS).sort()).toEqual([...declared].sort());
    });

    it('every v1 request member is unchanged in v2, required-ness included', async () => {
        const { SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        for (const [route, spec] of Object.entries(pinned!.verbs)) {
            expect({ route, request: (SIDECAR_WIRE as Wire)[route]!.request })
                .toEqual({ route, request: requiredMembers(spec.request) });
        }
    });

    it('every v1 response member is unchanged in v2', async () => {
        const { SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        for (const [route, spec] of Object.entries(pinned!.verbs)) {
            expect({ route, response: [...(SIDECAR_WIRE as Wire)[route]!.response].sort() })
                .toEqual({ route, response: responseMembers(spec.response) });
        }
    });

    it('error codes: every pinned v1 code survives and origin_read_only is the ONLY addition', async () => {
        const { ERROR_CODES, ERROR_SHAPE } = await import('../sidecar/contract.mjs');
        for (const code of pinned!.errors.codes) expect(ERROR_CODES).toContain(code);
        expect(ERROR_CODES.filter((c: string) => !pinned!.errors.codes.includes(c))).toEqual(['origin_read_only']);
        expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
        expect([...ERROR_SHAPE].sort()).toEqual(Object.keys(pinned!.errors.shape).sort());
    });

    it('the v2 routes are POST, none is forbidden, and there is no upload verb', async () => {
        const { FORBIDDEN_VERBS, V2_ROUTES } = await import('../sidecar/contract.mjs');
        for (const route of V2_ROUTES) {
            expect(route.startsWith('POST /')).toBe(true);
            expect(FORBIDDEN_VERBS).not.toContain(verbOf(route));
        }
        expect(V2_ROUTES.map(verbOf).sort()).toEqual(['fill_form', 'press', 'scroll', 'select']);
    });

    it('the Worker allowlist is EXACTLY the route verbs, and health is the only GET', async () => {
        const { SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        const { BROWSER_SIDECAR_GET_VERBS, BROWSER_SIDECAR_VERBS, resolveSidecarVerb } = await import('./browser-sidecar');
        const routes = Object.keys(SIDECAR_WIRE);
        expect([...BROWSER_SIDECAR_VERBS].sort()).toEqual(routes.map(verbOf).sort());
        expect(new Set(BROWSER_SIDECAR_VERBS).size).toBe(BROWSER_SIDECAR_VERBS.length);
        expect([...BROWSER_SIDECAR_GET_VERBS].sort())
            .toEqual(routes.filter((r) => r.startsWith('GET ')).map(verbOf).sort());
        // …and the resolver forwards each one with its declared method only.
        for (const route of routes) {
            const [method, path] = route.split(' ');
            const resolved = resolveSidecarVerb(verbOf(route), method!);
            expect(resolved).toEqual({ ok: true, verb: verbOf(route), method, url: `http://127.0.0.1:9223${path}` });
            const other = method === 'GET' ? 'POST' : 'GET';
            expect(resolveSidecarVerb(verbOf(route), other).ok).toBe(false);
        }
        expect(resolveSidecarVerb('upload', 'POST').ok).toBe(false);
    });

    it('/type really does carry `redacted` — a silent omission would be a lie to the agent', async () => {
        const { SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        expect(responseMembers(pinned!.verbs['POST /type'].response)).toContain('redacted');
        expect((SIDECAR_WIRE as Record<string, { response: string[] }>)['POST /type'].response).toContain('redacted');
    });

    it('/screenshot carries a sha256 the SIDECAR computes, not one the caller supplies', async () => {
        expect(responseMembers(pinned!.verbs['POST /screenshot'].response)).toContain('sha256');
        // The digest must be produced where the bytes are produced — that is
        // the property that makes the artefact evidence rather than a file.
        const verbsSource = readFileSync(join(import.meta.dir, '..', 'sidecar', 'verbs.mjs'), 'utf8');
        expect(verbsSource).toContain("createHash('sha256').update(buffer)");
        // …and never read out of the request.
        expect(verbsSource).not.toMatch(/sha256:\s*body\./);
    });

    it('stale_ref and bad_ref are BOTH present and distinct', async () => {
        const { ERROR_CODES } = await import('../sidecar/contract.mjs');
        expect(pinned!.errors.codes).toContain('stale_ref');
        expect(pinned!.errors.codes).toContain('bad_ref');
        expect(ERROR_CODES).toContain('stale_ref');
        expect(ERROR_CODES).toContain('bad_ref');
        // Collapsing them makes a recoverable state look like a mistake, so
        // the implementation must be able to raise each one on its own.
        const browserSource = readFileSync(join(import.meta.dir, '..', 'sidecar', 'browser.mjs'), 'utf8');
        expect(browserSource).toContain("err.code = 'bad_ref'");
        expect(browserSource).toContain("err.code = 'stale_ref'");
    });

    it('the transport facts match: 9223, 0.0.0.0, and NOT through preview-bridge', async () => {
        const { TRANSPORT } = await import('../sidecar/contract.mjs');
        expect(TRANSPORT.port).toBe(pinned!.transport.port);
        expect(TRANSPORT.bind).toBe(pinned!.transport.bind);
        expect(pinned!.transport.not_through).toContain('preview-bridge');
        // preview-bridge.ts must NOT have been widened to carry this port.
        const bridge = readFileSync(join(import.meta.dir, 'preview-bridge.ts'), 'utf8');
        expect(bridge).not.toContain(String(TRANSPORT.port));
        expect(bridge).not.toContain('BROWSER_SIDECAR_PORT');
    });

    it('the forbidden passthrough is forbidden in fact, not only in the contract', async () => {
        const { FORBIDDEN_VERBS, SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        const { VERBS } = await import('../sidecar/verbs.mjs');
        expect(pinned!.forbidden.cdp_passthrough.join(' ')).toContain('NO verb that forwards an arbitrary CDP command');
        // The pinned v1 routes, the v2 declaration AND the live handler map.
        const routes = [...Object.keys(pinned!.verbs), ...Object.keys(SIDECAR_WIRE), ...Object.keys(VERBS)]
            .map((r) => r.split(' ')[1]);
        for (const forbidden of FORBIDDEN_VERBS) {
            expect(routes).not.toContain(`/${forbidden}`);
        }
        // And the Worker-side allowlist cannot smuggle one in either.
        const { BROWSER_SIDECAR_VERBS } = await import('./browser-sidecar');
        for (const forbidden of FORBIDDEN_VERBS) {
            expect(BROWSER_SIDECAR_VERBS as readonly string[]).not.toContain(forbidden);
        }
    });

    it('the redaction rule the contract states is the rule this side implements', async () => {
        expect(pinned!.redaction.rule).toContain('input[type=password]');
        expect(pinned!.redaction.proof_required).toContain('mutation-proved');
        // Every surface the contract lists must be a real response path here.
        const routes = Object.keys(pinned!.verbs).map((r) => r.split(' ')[1]);
        for (const applies of pinned!.redaction.applies_to) {
            const path = applies.split(' ')[0];
            if (path.startsWith('/')) expect(routes).toContain(path);
        }
        // The guard exists, is a single choke point, and has a mutation proof
        // committed beside it.
        expect(existsSync(join(import.meta.dir, '..', 'sidecar', 'redact.mjs'))).toBe(true);
        const redactionTest = readFileSync(join(import.meta.dir, '..', 'sidecar', 'redaction.test.mjs'), 'utf8');
        expect(redactionTest).toContain('MUTATION PROCEDURE');
    });
});
