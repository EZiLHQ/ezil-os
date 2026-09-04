/**
 * The idempotent publisher of the community backlog.
 *
 * ## Why this exists, and what it deliberately is not
 *
 * `docs/community/issues/*.md` is the backlog kept as files, so it is reviewable
 * in a pull request and re-creatable if the GitHub issues are ever lost (plan
 * Part B §B3 row I6b; `docs/community/README.md`). This tool turns those files
 * into real GitHub issues, and its whole design goal is that running it twice
 * does nothing the first run did not.
 *
 * Idempotence is a property of the MARKER, not of a promise. Every rendered body
 * ends with a hidden `<!-- ezil-backlog-id: <ID> -->`, and an existing issue is
 * found by that marker in its body — never by title, because humans edit titles
 * and matching on one would re-create an issue the moment someone renamed it.
 * `findExisting` is the single place that decision is made; the test suite
 * mutation-proves it (swap the marker test for a title test and a renamed issue
 * is re-created — RED).
 *
 * The blast radius is bounded like `triage.ts`'s: **dry-run by default**, and
 * `--apply` is the only write. `--apply` CREATES MISSING ISSUES ONLY. It never
 * edits, never closes, never reopens, never labels an existing issue — the live
 * `Applier.create` is the one write path, and `createArgs` is a pure function
 * whose `gh` vector is `issue create` and nothing else, asserted by a test that
 * walks every token for a destructive verb. Drift between a file and its
 * published issue is REPORTED (`DRIFT #n <ID>: title differs`), never silently
 * corrected — a maintainer decides.
 *
 * ## The front-matter contract (a small strict parser, no dependency)
 *
 * Exactly five keys are required — `id` (string), `title` (string), `labels`
 * (flow list), `prereq` (string, may be empty), `state` (`open` | `blocked`) —
 * and `parseFrontMatter` FAILS LOUDLY, naming the file and the reason, on a
 * missing key, an unknown key, a duplicate key, a malformed list, an empty id
 * or title, or a state outside the pair. One optional key is tolerated:
 * `github` (a positive integer). It is tolerated rather than rejected because
 * the documented workflow writes the created issue number back into the
 * front-matter as `github: <n>` (a second, human-committed step); a parser that
 * rejected it would brick every idempotent re-run the moment the first number
 * was written back. `github` is recorded but is NOT used for matching — the
 * marker is. (Flagged in the row I6a report under _MANDATORY §3: the brief says
 * "exactly these keys", and this resolves the ambiguity the write-back creates.)
 *
 * ## Ordering
 *
 * `--apply` creates prerequisites before their dependants (SFA-01 before the
 * five viewers; MCP-01 before AGENT-01) so a later run can link a dependant's
 * body to a real number. `topoOrder` is a deterministic Kahn's pass over the
 * single-parent `prereq` edge, always emitting the alphabetically-smallest
 * available id; it FAILS on a cycle (naming the members) and on a dangling
 * prereq (a `prereq` that names no file).
 *
 * ## Bodies are rendered verbatim
 *
 * The GitHub issue body is the file body, unchanged, plus the footer line and
 * the marker. It is not the tool's place to rewrite the contributor's prose —
 * which means a link in the source renders exactly as written. The 22 bodies
 * today end with repository-relative links (`../../../CONTRIBUTING.md#...`) that
 * resolve for a file viewed in the tree but NOT from an `/issues/N` URL; that is
 * a fix for the source files (row I6b), handed off in the report, and NOT
 * measured here because measuring it would mean creating a live issue.
 *
 * ## No dependencies beyond Bun
 *
 * `Bun.spawn`, `node:fs`, `node:os`, `node:path`. The house style shared with
 * `triage.ts`, `waves.ts` and `ledger.ts`: typed `gh` failures, a pure testable
 * core, injected fetchers so no test ever reaches a real `gh`.
 */

import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// The front-matter contract, as data.
// ---------------------------------------------------------------------------

/** The two states a backlog issue may declare. Anything else is a parse failure. */
export const VALID_STATES = ["open", "blocked"] as const;
export type IssueState = (typeof VALID_STATES)[number];

/** The five keys every issue must carry. */
export const REQUIRED_KEYS = ["id", "title", "labels", "prereq", "state"] as const;

/** Keys tolerated in addition to the required five. `github` is the write-back key. */
export const OPTIONAL_KEYS = ["github"] as const;

const KNOWN_KEYS: ReadonlySet<string> = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------

export interface FrontMatter {
	readonly id: string;
	readonly title: string;
	readonly labels: readonly string[];
	readonly prereq: string;
	readonly state: IssueState;
	/** The published issue number, written back by a human after a create. Not used for matching. */
	readonly github?: number;
}

export interface BacklogIssue {
	readonly frontMatter: FrontMatter;
	readonly body: string;
	/** The file this was read from, e.g. `SFA-01.md`, used in every error message. */
	readonly source: string;
}

/**
 * An issue as `gh issue list --json number,title,state,labels,body` returns it.
 * `state` is gh's uppercase `OPEN`/`CLOSED` and is carried for reporting only —
 * a closed issue that already carries the marker still counts as existing, so no
 * classification branches on it.
 */
export interface GhIssue {
	readonly number: number;
	readonly title: string;
	readonly state: string;
	readonly labels: readonly string[];
	readonly body: string;
}

/** A malformed front-matter block; the message names the file and the reason. */
export class FrontMatterError extends Error {}
/** A backlog-level invariant broken: a cycle, a dangling prereq, a missing label, a duplicate id. */
export class BacklogError extends Error {}
/** A `gh` call failed, or returned a shape this tool refuses to guess at. */
export class GhError extends Error {}

// ---------------------------------------------------------------------------
// The front-matter parser. Strict: it would rather stop than mis-read.
// ---------------------------------------------------------------------------

/** Strip one layer of matching surrounding quotes from a scalar value. */
function unquoteScalar(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
	}
	return value;
}

/**
 * Parse a YAML flow list `[a, worker, "help wanted", "size/L"]`, respecting
 * quotes so a comma inside one does not split. An empty list `[]` is allowed; a
 * value that is not bracketed, an unterminated quote, or an empty item (a stray
 * comma) is a failure.
 */
export function parseLabels(value: string, source: string): string[] {
	const trimmed = value.trim();
	if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		throw new FrontMatterError(`${source}: "labels" must be a flow list like [a, "b c"], got ${JSON.stringify(value)}`);
	}
	const inner = trimmed.slice(1, -1);
	if (inner.trim() === "") return [];
	const items: string[] = [];
	let current = "";
	let quote: string | null = null;
	for (let i = 0; i < inner.length; i += 1) {
		const ch = inner[i] ?? "";
		if (quote !== null) {
			if (ch === quote) quote = null;
			else current += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
		} else if (ch === ",") {
			items.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	if (quote !== null) throw new FrontMatterError(`${source}: "labels" has an unterminated quote: ${JSON.stringify(value)}`);
	items.push(current);
	const labels = items.map((s) => s.trim());
	if (labels.some((s) => s === "")) {
		throw new FrontMatterError(`${source}: "labels" has an empty item (a stray comma?): ${JSON.stringify(value)}`);
	}
	return labels;
}

/**
 * Parse a `---`-fenced front-matter block plus the body after it. Every failure
 * mode names the source and the reason. Keys are split on the FIRST colon, so a
 * title or label may contain colons.
 */
export function parseFrontMatter(text: string, source: string): { frontMatter: FrontMatter; body: string } {
	if (!/^---[ \t]*\r?\n/.test(text)) {
		throw new FrontMatterError(`${source}: does not begin with a "---" front-matter fence`);
	}
	const lines = text.split(/\r?\n/);
	let end = -1;
	for (let i = 1; i < lines.length; i += 1) {
		if (/^---[ \t]*$/.test(lines[i] ?? "")) {
			end = i;
			break;
		}
	}
	if (end === -1) throw new FrontMatterError(`${source}: the front-matter fence is not closed by a "---" line`);
	const body = lines.slice(end + 1).join("\n");

	const raw = new Map<string, string>();
	for (let i = 1; i < end; i += 1) {
		const line = lines[i] ?? "";
		if (line.trim() === "") continue;
		const colon = line.indexOf(":");
		if (colon === -1) throw new FrontMatterError(`${source}: front-matter line is not "key: value": ${JSON.stringify(line)}`);
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim();
		if (key === "") throw new FrontMatterError(`${source}: a front-matter line has an empty key: ${JSON.stringify(line)}`);
		if (!KNOWN_KEYS.has(key)) {
			throw new FrontMatterError(
				`${source}: unknown front-matter key ${JSON.stringify(key)} (allowed: ${[...REQUIRED_KEYS, ...OPTIONAL_KEYS].join(", ")})`,
			);
		}
		if (raw.has(key)) throw new FrontMatterError(`${source}: duplicate front-matter key ${JSON.stringify(key)}`);
		raw.set(key, value);
	}

	for (const key of REQUIRED_KEYS) {
		if (!raw.has(key)) throw new FrontMatterError(`${source}: missing required front-matter key ${JSON.stringify(key)}`);
	}

	const id = unquoteScalar(raw.get("id") ?? "");
	if (id === "") throw new FrontMatterError(`${source}: "id" must be a non-empty string`);
	const title = unquoteScalar(raw.get("title") ?? "");
	if (title === "") throw new FrontMatterError(`${source}: "title" must be a non-empty string`);
	const labels = parseLabels(raw.get("labels") ?? "", source);
	const prereq = unquoteScalar(raw.get("prereq") ?? "");
	const stateRaw = unquoteScalar(raw.get("state") ?? "");
	if (!(VALID_STATES as readonly string[]).includes(stateRaw)) {
		throw new FrontMatterError(`${source}: "state" must be one of ${VALID_STATES.join("|")}, got ${JSON.stringify(stateRaw)}`);
	}
	const state = stateRaw as IssueState;

	let github: number | undefined;
	if (raw.has("github")) {
		const g = unquoteScalar(raw.get("github") ?? "");
		if (!/^[0-9]+$/.test(g)) {
			throw new FrontMatterError(`${source}: "github" must be a positive integer issue number, got ${JSON.stringify(g)}`);
		}
		github = Number(g);
	}

	const frontMatter: FrontMatter =
		github === undefined ? { id, title, labels, prereq, state } : { id, title, labels, prereq, state, github };
	return { frontMatter, body };
}

/**
 * Read and parse every `*.md` in `dir`, in name order. Also enforces that each
 * file's front-matter `id` equals its filename, so the marker and the `source:`
 * footer line are truthful about where the issue came from.
 */
export function loadIssues(dir: string): BacklogIssue[] {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.sort();
	const issues: BacklogIssue[] = [];
	for (const file of files) {
		const text = readFileSync(join(dir, file), "utf8");
		const { frontMatter, body } = parseFrontMatter(text, file);
		const expectedId = file.replace(/\.md$/, "");
		if (frontMatter.id !== expectedId) {
			throw new FrontMatterError(
				`${file}: front-matter id ${JSON.stringify(frontMatter.id)} does not match the filename (expected id ${JSON.stringify(expectedId)})`,
			);
		}
		issues.push({ frontMatter, body, source: file });
	}
	if (issues.length === 0) throw new BacklogError(`no *.md issue files found in ${dir}`);
	return issues;
}

// ---------------------------------------------------------------------------
// Rendering: the issue body and title a file becomes.
// ---------------------------------------------------------------------------

/** The hidden idempotence marker. Its presence in a body is what "already published" means. */
export function markerFor(id: string): string {
	return `<!-- ezil-backlog-id: ${id} -->`;
}

/** The search PHRASE (the marker's readable inner text) handed to `gh --search`. */
export function searchPhrase(id: string): string {
	return `ezil-backlog-id: ${id}`;
}

/** The footer line appended to every rendered body. */
export function footerLine(fm: FrontMatter): string {
	const prereq = fm.prereq === "" ? "none" : fm.prereq;
	return `Backlog id: ${fm.id} · prerequisite: ${prereq} · source: docs/community/issues/${fm.id}.md`;
}

/** The GitHub issue body: the file's body verbatim, then the footer, then the marker. */
export function renderBody(fm: FrontMatter, body: string): string {
	return `${body.trim()}\n\n${footerLine(fm)}\n\n${markerFor(fm.id)}`;
}

/** The GitHub issue title: the front-matter title, unchanged. */
export function renderTitle(fm: FrontMatter): string {
	return fm.title;
}

/** The labels a create applies: the front-matter list, plus `blocked` for a blocked issue (deduped, order kept). */
export function appliedLabels(fm: FrontMatter): string[] {
	const labels = [...fm.labels];
	if (fm.state === "blocked" && !labels.includes("blocked")) labels.push("blocked");
	return labels;
}

// ---------------------------------------------------------------------------
// Matching and classification. The marker decision lives in exactly one place.
// ---------------------------------------------------------------------------

/**
 * The published issue for `id`, found by the hidden marker in its body — the one
 * place existence is decided, and the mutation target for the idempotence proof.
 * Matching by title instead would re-create any issue a human had renamed.
 * `null` when none of the candidates carries the marker.
 */
export function findExisting(candidates: readonly GhIssue[], id: string): GhIssue | null {
	const marker = markerFor(id);
	const matches = candidates.filter((issue) => issue.body.includes(marker));
	if (matches.length === 0) return null;
	// Deterministic even if a marker somehow appears on more than one issue.
	return matches.reduce((lowest, issue) => (issue.number < lowest.number ? issue : lowest));
}

export type ClassifyKind = "create" | "exists" | "drift";

export interface Classification {
	readonly kind: ClassifyKind;
	readonly existing: GhIssue | null;
}

/**
 * Classify one file against the issues a search returned: `create` when no
 * marker matches, `exists` when the matched issue's title equals the rendered
 * title, `drift` when the marker matches but the title has diverged (scoped to
 * the title, per the brief; body drift is not reported).
 */
export function classify(fm: FrontMatter, candidates: readonly GhIssue[]): Classification {
	const existing = findExisting(candidates, fm.id);
	if (existing === null) return { kind: "create", existing: null };
	if (existing.title === renderTitle(fm)) return { kind: "exists", existing };
	return { kind: "drift", existing };
}

// ---------------------------------------------------------------------------
// Backlog-level validation: labels exist, and the DAG is orderable.
// ---------------------------------------------------------------------------

/** FAIL naming every label a file uses that the repo does not have. Label creation is a maintainer decision, not this tool's. */
export function validateLabels(issues: readonly BacklogIssue[], available: ReadonlySet<string>): void {
	const missing: string[] = [];
	for (const bi of issues) {
		for (const label of appliedLabels(bi.frontMatter)) {
			if (!available.has(label)) missing.push(`${JSON.stringify(label)} (used by ${bi.frontMatter.id})`);
		}
	}
	if (missing.length > 0) {
		throw new BacklogError(
			`these labels are named by the backlog but do not exist in the repo — a maintainer must create them, this tool will not: ${missing.join("; ")}`,
		);
	}
}

/**
 * Prerequisites before dependants, deterministic. Kahn's over the single-parent
 * `prereq` edge, always emitting the smallest available id. FAILS on a dangling
 * prereq (names no file) and on a cycle (naming its members). A duplicate id is
 * also refused here.
 */
export function topoOrder(issues: readonly BacklogIssue[]): BacklogIssue[] {
	const byId = new Map<string, BacklogIssue>();
	for (const bi of issues) {
		const existing = byId.get(bi.frontMatter.id);
		if (existing !== undefined) {
			throw new BacklogError(`duplicate backlog id ${JSON.stringify(bi.frontMatter.id)} in ${existing.source} and ${bi.source}`);
		}
		byId.set(bi.frontMatter.id, bi);
	}
	for (const bi of issues) {
		const p = bi.frontMatter.prereq;
		if (p !== "" && !byId.has(p)) {
			throw new BacklogError(`${bi.source}: prereq ${JSON.stringify(p)} names no issue in the backlog (dangling prerequisite)`);
		}
	}
	const indegree = new Map<string, number>();
	const dependents = new Map<string, string[]>();
	for (const id of byId.keys()) {
		indegree.set(id, 0);
		dependents.set(id, []);
	}
	for (const bi of issues) {
		const p = bi.frontMatter.prereq;
		if (p !== "") {
			indegree.set(bi.frontMatter.id, (indegree.get(bi.frontMatter.id) ?? 0) + 1);
			(dependents.get(p) ?? []).push(bi.frontMatter.id);
		}
	}
	const available = [...byId.keys()].filter((id) => (indegree.get(id) ?? 0) === 0);
	const ordered: BacklogIssue[] = [];
	while (available.length > 0) {
		available.sort();
		const id = available.shift() as string;
		ordered.push(byId.get(id) as BacklogIssue);
		for (const dep of dependents.get(id) ?? []) {
			const next = (indegree.get(dep) ?? 0) - 1;
			indegree.set(dep, next);
			if (next === 0) available.push(dep);
		}
	}
	if (ordered.length !== byId.size) {
		const emitted = new Set(ordered.map((b) => b.frontMatter.id));
		const cyclic = [...byId.keys()].filter((id) => !emitted.has(id)).sort();
		throw new BacklogError(`prereq cycle among: ${cyclic.join(", ")}`);
	}
	return ordered;
}

// ---------------------------------------------------------------------------
// The create vector: pure, and unable to express anything but a create.
// ---------------------------------------------------------------------------

export interface CreateSpec {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly labels: readonly string[];
}

/**
 * The exact `gh` argument vector for creating one issue. It is `issue create`
 * and nothing else — there is deliberately no branch that could `edit`, `close`,
 * `reopen`, `delete` or `transfer`. Pure and exported so a test can assert that
 * property over the vector.
 */
export function createArgs(spec: CreateSpec, repo: string, bodyPath: string): string[] {
	const args = ["issue", "create", "-R", repo, "--title", spec.title, "--body-file", bodyPath];
	for (const label of spec.labels) args.push("--label", label);
	return args;
}

/** The new issue number from `gh issue create`'s stdout (which is the created issue URL). */
export function parseCreatedNumber(stdout: string): number {
	const m = /\/issues\/(\d+)\b/.exec(stdout.trim());
	if (m === null || m[1] === undefined) {
		throw new GhError(`could not read the created issue number from gh output: ${JSON.stringify(stdout.trim())}`);
	}
	return Number(m[1]);
}

// ---------------------------------------------------------------------------
// gh I/O. Injected everywhere so no test reaches a real gh.
// ---------------------------------------------------------------------------

async function sh(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

async function ghJson<T>(args: string[]): Promise<T> {
	const { stdout, stderr, exitCode } = await sh(args);
	if (exitCode !== 0) throw new GhError(`gh ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
	try {
		return JSON.parse(stdout) as T;
	} catch (cause) {
		throw new GhError(`gh ${args.join(" ")} did not return JSON: ${String(cause)}`);
	}
}

/** From `gh issue list --json number,title,state,labels,body`; refuses a shape it cannot read. */
export function normalizeGhIssues(raw: unknown): GhIssue[] {
	if (!Array.isArray(raw)) throw new GhError("gh issue list: expected a JSON array");
	return raw.map((entry) => {
		const row = entry as { number?: unknown; title?: unknown; state?: unknown; labels?: unknown; body?: unknown };
		if (typeof row.number !== "number") throw new GhError("gh issue list: an issue has no numeric number");
		if (typeof row.title !== "string") throw new GhError(`gh issue list: issue #${row.number} has no string title`);
		const labels = Array.isArray(row.labels)
			? row.labels.map((label) => {
					const name = (label as { name?: unknown }).name;
					if (typeof name !== "string") throw new GhError(`gh issue list: issue #${row.number} has a label with no name`);
					return name;
				})
			: [];
		return {
			number: row.number,
			title: row.title,
			state: typeof row.state === "string" ? row.state : "",
			labels,
			body: typeof row.body === "string" ? row.body : "",
		};
	});
}

export interface Fetchers {
	/** The set of label names that exist in the repo. */
	availableLabels(repo: string): Promise<Set<string>>;
	/** Candidate issues for one backlog id (a `--search` over the marker phrase; refined by `findExisting`). */
	existingFor(repo: string, id: string): Promise<GhIssue[]>;
}

export interface Applier {
	/** Create one issue and return its number. Only ever called under `--apply`. */
	create(repo: string, spec: CreateSpec): Promise<number>;
}

/** The `gh issue list --search` vector for one id, exactly as the brief specifies. */
export function searchArgs(repo: string, id: string): string[] {
	return [
		"issue",
		"list",
		"-R",
		repo,
		"--state",
		"all",
		"--search",
		`"${searchPhrase(id)}" in:body`,
		"--json",
		"number,title,state,labels,body",
		"--limit",
		"100",
	];
}

const liveFetchers: Fetchers = {
	availableLabels: async (repo) => {
		// --limit 200: the default is 30 and a repo can have more, so a missing
		// label could otherwise be a paging artifact, not a real gap.
		const labels = await ghJson<{ name?: unknown }[]>(["label", "list", "-R", repo, "--limit", "200", "--json", "name"]);
		const set = new Set<string>();
		for (const label of labels) if (typeof label.name === "string") set.add(label.name);
		return set;
	},
	existingFor: async (repo, id) => normalizeGhIssues(await ghJson<unknown>(searchArgs(repo, id))),
};

const liveApplier: Applier = {
	create: async (repo, spec) => {
		// The body goes to a temp file OUTSIDE the repo — the tool never modifies docs/.
		const path = join(tmpdir(), `ezil-backlog-${spec.id}-${process.pid}-${Date.now()}.md`);
		writeFileSync(path, spec.body);
		try {
			const { stdout, stderr, exitCode } = await sh(createArgs(spec, repo, path));
			if (exitCode !== 0) throw new GhError(`gh issue create for ${spec.id} exited ${exitCode}: ${stderr.trim()}`);
			return parseCreatedNumber(stdout);
		} finally {
			try {
				rmSync(path);
			} catch {
				/* best effort; a leftover temp file is not worth failing a create over */
			}
		}
	},
};

// ---------------------------------------------------------------------------
// Orchestration and the JSON summary.
// ---------------------------------------------------------------------------

export interface WouldCreate {
	readonly id: string;
	readonly title: string;
	readonly labels: readonly string[];
}

export interface ExistsEntry {
	readonly number: number;
	readonly id: string;
	readonly title: string;
	readonly state: string;
}

export interface DriftEntry {
	readonly number: number;
	readonly id: string;
	readonly fileTitle: string;
	readonly issueTitle: string;
}

export interface CreatedEntry {
	readonly id: string;
	readonly number: number;
}

export interface Summary {
	readonly repo: string;
	/** wouldCreate.length + exists.length + drift.length. */
	readonly files: number;
	readonly wouldCreate: readonly WouldCreate[];
	readonly exists: readonly ExistsEntry[];
	readonly drift: readonly DriftEntry[];
	/** Populated only under --apply; empty on a dry run. */
	readonly created: readonly CreatedEntry[];
}

export interface RunOptions {
	readonly repo: string;
	readonly apply: boolean;
}

/**
 * Order, validate, classify, and (only under `apply`) create the missing issues.
 * Pure but for the injected `fetchers`/`applier`, so the whole flow is testable
 * without a real `gh`. Returns the JSON summary and the human-readable lines.
 */
export async function run(
	issues: readonly BacklogIssue[],
	options: RunOptions,
	fetchers: Fetchers,
	applier: Applier,
): Promise<{ summary: Summary; lines: string[] }> {
	const { repo, apply } = options;
	const lines: string[] = [];

	const ordered = topoOrder(issues);
	const available = await fetchers.availableLabels(repo);
	validateLabels(ordered, available);

	const wouldCreate: WouldCreate[] = [];
	const exists: ExistsEntry[] = [];
	const drift: DriftEntry[] = [];
	const toCreate: BacklogIssue[] = [];

	for (const bi of ordered) {
		const fm = bi.frontMatter;
		const candidates = await fetchers.existingFor(repo, fm.id);
		const classification = classify(fm, candidates);
		const labels = appliedLabels(fm);
		if (classification.kind === "create") {
			wouldCreate.push({ id: fm.id, title: renderTitle(fm), labels });
			toCreate.push(bi);
			lines.push(`would create ${fm.id} ${JSON.stringify(renderTitle(fm))} [${labels.join(", ")}]`);
		} else if (classification.kind === "exists") {
			const e = classification.existing as GhIssue;
			exists.push({ number: e.number, id: fm.id, title: e.title, state: e.state });
			lines.push(`exists #${e.number} ${fm.id}`);
		} else {
			const e = classification.existing as GhIssue;
			drift.push({ number: e.number, id: fm.id, fileTitle: renderTitle(fm), issueTitle: e.title });
			lines.push(`DRIFT #${e.number} ${fm.id}: title differs`);
		}
	}

	const created: CreatedEntry[] = [];
	if (apply) {
		for (const bi of toCreate) {
			const fm = bi.frontMatter;
			const spec: CreateSpec = { id: fm.id, title: renderTitle(fm), body: renderBody(fm, bi.body), labels: appliedLabels(fm) };
			const number = await applier.create(repo, spec);
			created.push({ id: fm.id, number });
			lines.push(
				`created #${number} ${fm.id} — add this line to docs/community/issues/${fm.id}.md front-matter, then commit:  github: ${number}`,
			);
		}
	}

	const files = wouldCreate.length + exists.length + drift.length;
	const summary: Summary = { repo, files, wouldCreate, exists, drift, created };
	lines.push(
		`${apply ? "APPLIED" : "dry run"}: ${files} file(s); ${wouldCreate.length} to create, ${exists.length} exist, ${drift.length} drift` +
			(apply ? `, ${created.length} created.` : ".") +
			" This tool never edits or closes an existing issue.",
	);
	return { summary, lines };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export interface CliArgs {
	readonly repo: string;
	readonly apply: boolean;
	readonly issuesDir: string | null;
	readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
	let repo = "EZiLHQ/ezil-os";
	let apply = false;
	let issuesDir: string | null = null;
	let help = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--repo") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error("--repo needs an owner/name value.");
			repo = value;
			i += 1;
		} else if (arg === "--issues-dir") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error("--issues-dir needs a path.");
			issuesDir = value;
			i += 1;
		} else if (arg === "--apply") {
			apply = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else {
			throw new Error(`unknown argument ${JSON.stringify(arg)}. Flags: --repo <owner/name>, --issues-dir <path>, --apply.`);
		}
	}
	return { repo, apply, issuesDir, help };
}

export function defaultIssuesDir(): string {
	return join(import.meta.dir, "..", "docs", "community", "issues");
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stderr.write(
			"issues.ts — idempotent publisher of the community backlog (docs/community/issues/*.md).\n" +
				"  --repo <owner/name>   default EZiLHQ/ezil-os\n" +
				"  --issues-dir <path>   default <repo>/docs/community/issues\n" +
				"  --apply               the ONLY flag that writes: creates MISSING issues only,\n" +
				"                        never edits or closes an existing one. Default is a dry run.\n",
		);
		process.exit(0);
	}

	const dir = args.issuesDir ?? defaultIssuesDir();
	const issues = loadIssues(dir);
	const { summary, lines } = await run(issues, { repo: args.repo, apply: args.apply }, liveFetchers, liveApplier);

	for (const line of lines) process.stderr.write(`${line}\n`);
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
