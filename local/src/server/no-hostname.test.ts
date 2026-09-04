/**
 * No literal hostname anywhere under `local/src`.
 *
 * 🔴 WHAT THIS IS ACTUALLY PROTECTING. Local mode's premise is that it runs on
 * a machine with no Cloudflare account, no EZiL account and — if the user wants
 * — no internet. A hardcoded `*.ezil.work` / `*.workers.dev` / `*.vercel.app`
 * would be a call home nobody asked for, and it is not hypothetical on this
 * codebase: `../container/run-spec.ts` documents neko's own
 * `--webrtc.ip_retrieval_url`, which defaults to `checkip.amazonaws.com` and
 * fetches the user's public IP on every boot unless `nat1to1` is set.
 *
 * Every address this package uses is composed from `LOCAL_BIND_ADDRESS` plus a
 * port out of `LOCAL_PORT_MAP`. Anything remote is CONFIGURATION — unset by
 * default, supplied by the user, never a literal in the source.
 *
 * ── Two rules, because a vendor NAME is not an ADDRESS ──────────────────────
 * A match inside a COMMENT is allowed: naming the primitive a piece of code
 * replaces is exactly what the comments in this package are for, and refusing
 * them would mean deleting the explanations that make the code reviewable.
 *
 *   RULE A — a HOSTNAME token in CODE is refused absolutely. No allowance, no
 *            exception, no file. This is the one that matters.
 *   RULE B — the bare vendor NAME in CODE is allowed only in the files listed
 *            in `VENDOR_CODE_ALLOWANCES`, at an EXACT count, each with a stated
 *            reason. Rewording an explanation stays green; adding an occurrence
 *            does not.
 *
 * ── Known limit, stated rather than papered over ────────────────────────────
 * The comment classifier is line-based: it understands `//`, `/* … *\/` and
 * block continuations, and it does NOT understand a `//` that appears inside a
 * string literal. On this package that costs nothing (no such string exists,
 * and the test would fail LOUD if one were added while carrying a token). A
 * real parse would be a second TypeScript front end for a grep.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * The tokens, assembled from fragments.
 *
 * 🔴 NOT WRITTEN AS LITERALS, and that is load-bearing rather than cute: this
 * file lives inside the tree it scans, so a literal token here would be a hit
 * in code and the test would fail on itself. Assembling them means the scan can
 * cover EVERY file under `src/`, including the tests, with no exclusions to
 * quietly grow.
 */
export const FORBIDDEN_TOKENS: readonly string[] = [
    ['ezil', '.org'].join(''),
    ['ezil', '.work'].join(''),
    ['vercel', '.app'].join(''),
    ['cloud', 'flare'].join(''),
    ['workers', '.dev'].join(''),
    ['amazon', 'aws.com'].join(''),
];

export interface TokenHit {
    readonly file: string;
    readonly line: number;
    readonly token: string;
    readonly inComment: boolean;
    readonly text: string;
}

/** Where a line's comment begins, or `null` when the whole line is code. */
function commentStart(line: string, inBlock: boolean): { start: number | null; blockAfter: boolean } {
    if (inBlock) {
        const close = line.indexOf('*/');
        // Still inside a block: the whole line is comment. Closing it mid-line
        // means the tail is code, and the tail is what a later `//` would apply
        // to — but a token in the tail is then correctly classified as code.
        if (close === -1) return { start: 0, blockAfter: true };
        const rest = line.slice(close + 2);
        const nested = commentStart(rest, false);
        return {
            start: nested.start === null ? null : close + 2 + nested.start,
            blockAfter: nested.blockAfter,
        };
    }
    const lineComment = lineCommentIndex(line);
    const blockOpen = line.indexOf('/*');
    if (blockOpen !== -1 && (lineComment === -1 || blockOpen < lineComment)) {
        const close = line.indexOf('*/', blockOpen + 2);
        // Still open at end of line: everything from `/*` onwards is comment.
        if (close === -1) return { start: blockOpen, blockAfter: true };
        // 🔴 IT CLOSED ON THIS LINE, so the TAIL IS CODE. Returning `blockOpen`
        // here marked `/* one *​/ const a = '<token>';` as a comment and would
        // have waved through a literal hostname on any line that happened to
        // start with an inline block comment. Caught by this file's own
        // classifier test, not by review.
        const tail = commentStart(line.slice(close + 2), false);
        return {
            start: tail.start === null ? null : close + 2 + tail.start,
            blockAfter: tail.blockAfter,
        };
    }
    if (lineComment !== -1) return { start: lineComment, blockAfter: false };
    return { start: null, blockAfter: false };
}

/**
 * The index of a real `//` comment, skipping the one inside a URL scheme.
 *
 * 🔴 THE HOLE THIS CLOSES IS THE WHOLE POINT OF THE FILE. A naive
 * `indexOf('//')` matches the slashes in `https://`, so
 * `const home = 'https://os.<host>/api';` classified as a COMMENT and the
 * scanner waved through the single thing it exists to catch. Found by this
 * file's own positive control, which is the only reason it is not still there.
 */
function lineCommentIndex(line: string): number {
    for (let i = 0; i < line.length - 1; i += 1) {
        if (line[i] !== '/' || line[i + 1] !== '/') continue;
        if (i > 0 && line[i - 1] === ':') continue; // `http://`, `ws://`, `file://`
        return i;
    }
    return -1;
}

/** Every forbidden token in one file's text, classified as comment or code. */
export function scanText(file: string, text: string): TokenHit[] {
    const hits: TokenHit[] = [];
    let inBlock = false;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        const { start, blockAfter } = commentStart(line, inBlock);
        const wasInBlock = inBlock;
        inBlock = blockAfter;
        const lower = line.toLowerCase();
        for (const token of FORBIDDEN_TOKENS) {
            let at = lower.indexOf(token);
            while (at !== -1) {
                const commentFrom = wasInBlock ? 0 : start;
                hits.push({
                    file,
                    line: i + 1,
                    token,
                    inComment: commentFrom !== null && at >= commentFrom,
                    text: line.trim(),
                });
                at = lower.indexOf(token, at + 1);
            }
        }
    }
    return hits;
}

/** Every `.ts` file under a directory. */
export function typescriptFiles(root: string): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            if (entry === 'node_modules') continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) walk(full);
            else if (entry.endsWith('.ts')) out.push(full);
        }
    };
    walk(root);
    return out;
}

const SRC = resolve(import.meta.dir, '..');

/**
 * The tokens that are HOSTNAMES. A literal one of these in code is an address,
 * and there is no version of local mode that needs one — it is refused
 * absolutely, with no allowance and no exception.
 */
export const DOMAIN_TOKENS: readonly string[] = FORBIDDEN_TOKENS.filter((t) => t.includes('.'));

/**
 * The vendor NAME is a different thing from an address, and refusing it in code
 * outright would be refusing facts.
 *
 * Each file below is allowed an EXACT number of code occurrences, and the
 * reason is stated. A count rather than the line text, so re-wording an
 * explanation does not fail the build while ADDING one still does.
 */
const VENDOR_CODE_ALLOWANCES: readonly { readonly file: string; readonly count: number; readonly why: string }[] = [
    {
        file: 'boot/payload.ts',
        count: 1,
        why: '`ShellDesktopState.provider` is a LITERAL type in the app and the field is not'
            + ' optional, so the value must be emitted for the payload to typecheck. It is'
            + ' factually wrong for local mode, it has ZERO readers in `shell/`, and'
            + ' `../boot/payload.ts` says both at the definition. Widening the type is a change'
            + ' to a file this package does not own.',
    },
    {
        file: 'contract/shell-api.test.ts',
        count: 1,
        why: "row T0's adversarial payload fixture, which mirrors the app's literal provider tag"
            + ' so the two serializers can be compared byte for byte.',
    },
    {
        file: 'container/run-spec.ts',
        count: 1,
        why: "prose inside the `why:` field of the port table — a sentence about which capability"
            + ' the hosted platform lacks, not an address.',
    },
    {
        file: 'server/shell-contract.test.ts',
        count: 1,
        why: 'a repository FILE PATH under `app/src/server/lib/` (the desktop provider module),'
            + ' read at test time to pin the focusable-app enum against its upstream declaration.'
            + ' A path inside this repository, not a host.',
    },
];

describe('the forbidden-token scanner', () => {
    it('finds a token in code and reports it as code', () => {
        // POSITIVE CONTROL for every negative below: without this, a scanner
        // that found nothing at all would make the whole suite pass.
        const evil = `const home = 'https://os.${['ezil', '.work'].join('')}/api';`;
        const hits = scanText('x.ts', evil);
        expect(hits.length).toBe(1);
        expect(hits[0]?.inComment).toBe(false);
    });

    it('classifies a line comment, a trailing comment and a block comment', () => {
        const token = ['workers', '.dev'].join('');
        expect(scanText('x.ts', `// see ${token} for why`)[0]?.inComment).toBe(true);
        expect(scanText('x.ts', `const a = 1; // not ${token}`)[0]?.inComment).toBe(true);
        expect(scanText('x.ts', `/**\n * ${token}\n */`)[0]?.inComment).toBe(true);
        expect(scanText('x.ts', `/* one */ const a = '${token}';`)[0]?.inComment).toBe(false);
    });

    it('a token before a trailing comment on the same line is CODE', () => {
        const token = ['vercel', '.app'].join('');
        const hits = scanText('x.ts', `const a = '${token}'; // explained here`);
        expect(hits[0]?.inComment).toBe(false);
    });

    it('scans something: the tree is not empty', () => {
        const files = typescriptFiles(SRC);
        expect(files.length).toBeGreaterThan(8);
        // This very file must be among them — the scan has NO exclusions, which
        // is why the tokens above are assembled rather than written out.
        expect(files.some((f) => f.endsWith('no-hostname.test.ts'))).toBe(true);
    });
});

describe('local/src carries no literal hostname in code', () => {
    const allHits = typescriptFiles(SRC).flatMap((f) => scanText(relative(SRC, f), readFileSync(f, 'utf8')));

    it('🔴 NO literal hostname appears in code. No exceptions, anywhere.', () => {
        const hostnameInCode = allHits.filter((h) => !h.inComment && DOMAIN_TOKENS.includes(h.token));
        // The message carries the offending lines, so a failure names the file
        // and the text rather than a count.
        expect(hostnameInCode.map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
    });

    it('every vendor NAME in code is on the pinned, counted allowance', () => {
        const vendorInCode = allHits.filter((h) => !h.inComment && !DOMAIN_TOKENS.includes(h.token));
        const byFile = new Map<string, number>();
        for (const h of vendorInCode) {
            const f = h.file.replace(/\\/g, '/');
            byFile.set(f, (byFile.get(f) ?? 0) + 1);
        }
        const unexpected = vendorInCode
            .filter((h) => !VENDOR_CODE_ALLOWANCES.some((a) => a.file === h.file.replace(/\\/g, '/')))
            .map((h) => `${h.file}:${h.line} ${h.text}`);
        expect(unexpected).toEqual([]);
        // 🔴 AND THE COUNT IS EXACT. An allowance is for the occurrences that
        // were reviewed; a file that grew a second one has grown something
        // nobody looked at.
        for (const allowance of VENDOR_CODE_ALLOWANCES) {
            expect(`${allowance.file} -> ${byFile.get(allowance.file) ?? 0}`)
                .toBe(`${allowance.file} -> ${allowance.count}`);
        }
        expect(VENDOR_CODE_ALLOWANCES.every((a) => a.why.length > 40)).toBe(true);
    });

    it('no URL to a forbidden host appears in code, comment or not', () => {
        // The stricter half. A vendor NAME in a comment is an explanation; a
        // fetchable URL in code is a call home, and the one legitimate
        // occurrence in this package (`checkip.amazonaws.com`, in
        // `container/run-spec.ts`) is a comment describing the call that
        // `NEKO_WEBRTC_NAT1TO1` exists to prevent.
        const urls = allHits.filter((h) => !h.inComment && /https?:\/\//.test(h.text));
        expect(urls.map((h) => `${h.file}:${h.line} ${h.text}`)).toEqual([]);
    });

    it('the comment hits that DO exist are real, so the scanner is not blind', () => {
        // POSITIVE CONTROL over the real tree: T0's files explain the
        // Cloudflare primitives they replace at length, so a scanner reporting
        // zero comment hits would be a scanner that is not looking.
        expect(allHits.filter((h) => h.inComment).length).toBeGreaterThan(20);
    });
});
