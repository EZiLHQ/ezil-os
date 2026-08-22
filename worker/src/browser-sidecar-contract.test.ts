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
 * ── Why a skip is possible, and why it is loud ──────────────────────────────
 * The contract lives in a sibling checkout. When that checkout is absent this
 * suite CANNOT run, and this repo's convention (contract §10 / the container
 * suites) is that a suite which could not run must never look like a pass.
 * It therefore skips with a banner naming the exact path it wanted, and
 * `EZIL_BROWSER_SIDECAR_CONTRACT` overrides the location.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_CONTRACT = join(
    import.meta.dir, '..', '..', '..',
    'EZiL-Works', 'apps', 'api', 'src', 'routes', 'mcp', 'browser-sidecar.contract.json',
);
const CONTRACT_PATH = process.env.EZIL_BROWSER_SIDECAR_CONTRACT ?? DEFAULT_CONTRACT;
const HAVE_CONTRACT = existsSync(CONTRACT_PATH);

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

describeIf('worker/sidecar conforms to the pinned wire contract', () => {
    it('the contract file itself is the version this side was written against', () => {
        expect(pinned!.version).toBe('1');
    });

    it('serves EXACTLY the routes the contract names — no more, no fewer', async () => {
        const { SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        const { VERBS } = await import('../sidecar/verbs.mjs');
        const contractRoutes = Object.keys(pinned!.verbs).sort();
        // Both the declaration AND the live handler map, so a handler that
        // exists without a declaration (or vice versa) cannot hide here.
        expect(Object.keys(SIDECAR_WIRE).sort()).toEqual(contractRoutes);
        expect(Object.keys(VERBS).sort()).toEqual(contractRoutes);
    });

    it('every request member matches, required-ness included', async () => {
        const { SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        for (const [route, spec] of Object.entries(pinned!.verbs)) {
            expect({ route, request: (SIDECAR_WIRE as Record<string, { request: Record<string, boolean> }>)[route].request })
                .toEqual({ route, request: requiredMembers(spec.request) });
        }
    });

    it('every response member matches', async () => {
        const { SIDECAR_WIRE } = await import('../sidecar/contract.mjs');
        for (const [route, spec] of Object.entries(pinned!.verbs)) {
            expect({ route, response: [...(SIDECAR_WIRE as Record<string, { response: string[] }>)[route].response].sort() })
                .toEqual({ route, response: responseMembers(spec.response) });
        }
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
        expect([...ERROR_CODES].sort()).toEqual([...pinned!.errors.codes].sort());
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
        const { FORBIDDEN_VERBS } = await import('../sidecar/contract.mjs');
        expect(pinned!.forbidden.cdp_passthrough.join(' ')).toContain('NO verb that forwards an arbitrary CDP command');
        const routes = Object.keys(pinned!.verbs).map((r) => r.split(' ')[1]);
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
