/**
 * A deterministic triage pass over the repository's open pull requests and
 * issues.
 *
 * ## Why this exists, and what it deliberately is not
 *
 * The intake routine (plan Part B §B5) is a supervisor loop: a model reads what
 * changed, drafts review text, and a maintainer merges. A model reading a wall
 * of `gh` output and deciding what to say is neither cheap nor reproducible --
 * two runs over the same repository disagree. So the *decisions* live here, as
 * pure functions over typed inputs, and the model is left only the prose it is
 * actually good at. `classifyPr` given the same PR, checks, commits and
 * main-branch checks returns the same findings every time, and the tests below
 * pin every one of them.
 *
 * The blast radius is bounded by construction. This tool **never closes, never
 * merges, never re-runs a workflow, and never edits a body or title.** The only
 * writes it can perform are adding a comment and adjusting labels, and even
 * those happen only under `--post`; the default is a dry run that prints what it
 * would do. `applyActions` accepts a closed union of three action kinds
 * (`comment`, `add-label`, `remove-label`) so that "it cannot close a PR" is a
 * property of the type, not a promise in a comment -- see `argsFor`, whose
 * switch has nowhere to put a destructive verb, and the test that walks every
 * action every fixture produces and asserts none escapes that set.
 *
 * ## Machine state lives outside the repository
 *
 * "What did I last look at" is a cursor, and a cursor is machine state, not
 * source. It is written to `${XDG_CACHE_HOME:-~/.cache}/ezil-os/triage-cursor.json`,
 * never inside the checkout, so a scheduled run on a loop leaves the working
 * tree untouched and `git status` stays clean. A dry run writes nothing at all,
 * cursor included; only `--post` advances it.
 *
 * ## The two contracts this file mirrors, and how they drift
 *
 * `REQUIRED_CONTEXTS` is the fifteen status checks that branch-protection
 * ruleset 22265548 requires on `main` (measured 2026-09-05, not assumed). It is
 * a constant here because `classifyPr` must be pure and the tests must be
 * deterministic, but a constant that mirrors a live ruleset drifts silently --
 * exactly the failure mode this project keeps paying for. So the CLI cross-checks
 * the constant against the live ruleset at run time and prints a loud warning to
 * stderr, and surfaces the drift in the JSON, rather than trusting the constant
 * blindly. `container (real image)`, `local (typecheck + unit + smoke)` and
 * `Vercel` are deliberately NOT in the set: a fork PR cannot pull the private
 * desktop image, so those go red on every outside contribution -- see
 * `.github/workflows/ci.yml` lines 62-72. A red check outside the required set
 * is `not-required-red`, and that classification takes precedence over
 * `ci-flaky` (a non-required check that happens to be green on `main` is still
 * the fork limitation, not a flake).
 *
 * The DCO rule is a faithful re-implementation of `.github/workflows/dco.yml`:
 * merge commits are skipped; the three bot authors it names are skipped by the
 * SAME commit-author ident test (email suffix `@users.noreply.github.com` AND a
 * name in the list), FIRST, before any trailer is read -- because the real
 * Dependabot commit carries a `Signed-off-by` whose email does NOT match its
 * author, and an "is a trailer missing?" gate would fail it; a trailer matches
 * when its name equals the author name exactly and its email equals the author
 * email case-insensitively. dco.yml is the authority; this is advisory, and the
 * worst a divergence can do is post or withhold one advisory comment.
 *
 * ## Fixtures
 *
 * `tools/fixtures/triage/*.json` are captured from real `gh` output shapes; a
 * `gh` upgrade can change those shapes and invalidate them. See the header of
 * `triage.test.ts` for the provenance of each and how the flaky/red cases are
 * anchored to a measured shell flake.
 *
 * No dependencies beyond Bun (`Bun.spawn`, `node:os`, `node:fs`), the house
 * style shared with `waves.ts` and `ledger.ts`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// The two mirrored contracts, as data.
// ---------------------------------------------------------------------------

/**
 * The fifteen required status contexts on `main`, from ruleset 22265548
 * (`gh api repos/EZiLHQ/ezil-os/rulesets/22265548`, measured 2026-09-05).
 * `container (real image)`, `local (typecheck + unit + smoke)` and `Vercel` are
 * intentionally absent -- see the file header.
 */
export const REQUIRED_CONTEXTS: readonly string[] = [
	"worker (typecheck + unit) (ubuntu-latest)",
	"worker (typecheck + unit) (windows-latest)",
	"worker (typecheck + unit) (macos-latest)",
	"app (typecheck + unit) (ubuntu-latest)",
	"app (typecheck + unit) (windows-latest)",
	"app (typecheck + unit) (macos-latest)",
	"sdk + mcp (typecheck + unit) (ubuntu-latest)",
	"sdk + mcp (typecheck + unit) (windows-latest)",
	"sdk + mcp (typecheck + unit) (macos-latest)",
	"shell (bundle check + browser suites) (ubuntu-latest)",
	"shell (bundle check + browser suites) (windows-latest)",
	"shell (bundle check + browser suites) (macos-latest)",
	"tools (typecheck + unit)",
	"DCO",
	"CodeQL (javascript-typescript)",
];

const REQUIRED_SET: ReadonlySet<string> = new Set(REQUIRED_CONTEXTS);

/**
 * Bot commit authors that cannot sign the DCO, matched on the git author ident
 * exactly as `dco.yml` does. Kept as data so the DCO test can assert the
 * Dependabot email-mismatch trap directly.
 */
export const BOT_NAMES: readonly string[] = ["dependabot[bot]", "github-actions[bot]", "copilot-swe-agent[bot]"];
export const BOT_EMAIL_SUFFIX = "@users.noreply.github.com";

/** The ten path labels from `.github/labeler.yml`; an issue carrying none of these needs triage. */
export const AREA_LABELS: readonly string[] = ["app", "worker", "sdk", "shell", "mcp", "e2e", "docs", "ci", "local", "tools"];

/** The five size labels, in ascending order. */
export const SIZE_LABELS: readonly string[] = ["size/XS", "size/S", "size/M", "size/L", "size/XL"];

// ---------------------------------------------------------------------------
// Types. `Check` is the normalised shape both `gh pr checks` and the commit
// check-runs API are reduced to, so `classifyPr` never sees two shapes.
// ---------------------------------------------------------------------------

/** gh's rollup bucket for a single check. */
export type Bucket = "pass" | "fail" | "pending" | "skipping" | "cancel";
const BUCKETS: ReadonlySet<string> = new Set<Bucket>(["pass", "fail", "pending", "skipping", "cancel"]);

export interface Check {
	readonly name: string;
	readonly bucket: Bucket;
}

export interface Author {
	readonly login: string;
	readonly is_bot: boolean;
}

export interface Label {
	readonly name: string;
}

export interface PullRequest {
	readonly number: number;
	readonly title: string;
	readonly author: Author;
	readonly isDraft: boolean;
	readonly labels: readonly Label[];
	readonly additions: number;
	readonly deletions: number;
	readonly headRefName: string;
	readonly body: string;
	readonly updatedAt: string;
}

export interface Issue {
	readonly number: number;
	readonly title: string;
	readonly labels: readonly Label[];
	readonly body: string;
	readonly updatedAt: string;
}

/** A commit reduced from the pulls/{n}/commits REST shape to what the DCO rule needs. */
export interface Commit {
	readonly sha: string;
	readonly authorName: string;
	readonly authorEmail: string;
	readonly message: string;
	/** Parent count; > 1 is a merge commit, which the DCO rule skips. */
	readonly parents: number;
}

/**
 * The closed set of findings `classifyPr` may return, in the canonical order
 * they are reported and merged into a comment.
 */
export const FINDING_ORDER = [
	"missing-dco",
	"template-incomplete",
	"ci-red",
	"ci-flaky",
	"not-required-red",
	"size-xl",
	"draft",
	"ready-for-review",
] as const;

export type Finding = (typeof FINDING_ORDER)[number];

// ---------------------------------------------------------------------------
// Comment templates. Only the findings a contributor can act on get a body;
// `draft` and `ready-for-review` are status signals the supervisor reads from
// the JSON (§B5 routes `ready-for-review` to a review, not a canned comment),
// and templating them would put a comment on every PR since one of the two
// always fires. The absence of those two keys is asserted by the tests so the
// interpretation is pinned, not merely omitted.
// ---------------------------------------------------------------------------

const REPO_BLOB = "https://github.com/EZiLHQ/ezil-os/blob/main";

/**
 * The findings that carry a contributor-facing comment. `CommentFinding` is the
 * key type of `TEMPLATES`; the two status findings are excluded by omission.
 */
export type CommentFinding = "missing-dco" | "template-incomplete" | "ci-red" | "ci-flaky" | "not-required-red" | "size-xl";

export const TEMPLATES: Readonly<Record<CommentFinding, string>> = {
	"missing-dco": `### Missing or mismatched sign-off (DCO)

One or more commits on this PR are missing a \`Signed-off-by\` trailer, or carry one whose name and email do not match the commit author. Every commit must certify the [Developer Certificate of Origin](https://developercertificate.org/) — see [CONTRIBUTING.md § Sign-off (DCO)](${REPO_BLOB}/CONTRIBUTING.md#sign-off-dco).

To fix:

- one commit: \`git commit --amend -s && git push --force-with-lease\`
- several commits: \`git rebase --signoff <base> && git push --force-with-lease\`

\`<base>\` is the commit your branch started from (usually \`origin/main\`). If the trailer is present but mismatched, set \`user.name\` and \`user.email\` to the identity you sign with, then amend or rebase as above.`,

	"template-incomplete": `### The pull request description looks incomplete

This PR's description contains none of the checklist items from the [pull request template](${REPO_BLOB}/.github/PULL_REQUEST_TEMPLATE.md). Please edit the description to keep the template's checklist — what changed, the size, the linked issue, and the sign-off / testing boxes — so a reviewer can see what was done and how it was tested. See [CONTRIBUTING.md § How to send a PR](${REPO_BLOB}/CONTRIBUTING.md#how-to-send-a-pr).`,

	"ci-red": `### CI is red

A required check failed here, and the same check is green on \`main\` for the same name — so this is a failure the change introduced, not a known flake. Open the failing check, read the failing step, and push a fix. See [CONTRIBUTING.md § Reading CI](${REPO_BLOB}/CONTRIBUTING.md#reading-ci). If you believe the failure is unrelated to your change, say so here and a maintainer will take a look.`,

	"ci-flaky": `### A known-flaky check failed

A check failed here that is currently green on \`main\` for the same name, and it is one this project has watched flake before — this is not your change. A maintainer will re-run it; there is nothing you need to do. If it fails again after a re-run it is tracked in the flake backlog. See [CONTRIBUTING.md § Reading CI](${REPO_BLOB}/CONTRIBUTING.md#reading-ci).`,

	"not-required-red": `### A non-required check is red

\`container (real image)\` and \`local (typecheck + unit + smoke)\` pull the desktop image from a private GitHub Container Registry package. A pull request from a fork — and a developer on an unprivileged machine — cannot read that package, so those checks come up red or skipped on outside contributions no matter what you changed (see [\`.github/workflows/ci.yml\` lines 62–72](${REPO_BLOB}/.github/workflows/ci.yml#L62-L72)). The \`Vercel\` preview deploy is a third-party check on the same footing. Neither is one of the fifteen required contexts, so this does not block your merge.`,

	"size-xl": `### This pull request is large (size/XL)

This change is over 1000 lines added + deleted, which is hard to review well. Where you can, split it into a stack of smaller PRs along natural seams — one concern per PR. See [CONTRIBUTING.md § PR size](${REPO_BLOB}/CONTRIBUTING.md#pr-size). If it genuinely cannot be split, say why here so a reviewer knows what they are looking at.`,
};

const COMMENT_FOOTER = `<sub>Automated triage from \`tools/triage.ts\` (dry-run by default; a maintainer runs \`--post\`). Reply here if something looks wrong.</sub>`;

/** The idempotence marker a posted section carries, so a re-run skips a finding already commented. */
export function marker(finding: Finding): string {
	return `<!-- ezil-triage: ${finding} -->`;
}

function isCommentFinding(finding: Finding): finding is CommentFinding {
	return finding in TEMPLATES;
}

// ---------------------------------------------------------------------------
// Pure classification.
// ---------------------------------------------------------------------------

/** XS <= 20, S <= 100, M <= 400, L <= 1000, XL > 1000, over additions + deletions. */
export function sizeBucket(changedLines: number): "XS" | "S" | "M" | "L" | "XL" {
	if (changedLines <= 20) return "XS";
	if (changedLines <= 100) return "S";
	if (changedLines <= 400) return "M";
	if (changedLines <= 1000) return "L";
	return "XL";
}

export function sizeLabel(changedLines: number): string {
	return `size/${sizeBucket(changedLines)}`;
}

/**
 * A markdown task-list checkbox anywhere in the body. The template's completeness
 * signal is coarse on purpose: a body that kept the template (even with every box
 * unchecked) has checkboxes and is fine; a body that replaced the template with
 * prose, or is empty, has none. This is decoupled from the exact checkbox text,
 * which row I1 owns and may reword.
 */
export function hasChecklist(body: string): boolean {
	return /^[ \t]*[-*][ \t]*\[[ xX]\]/m.test(body);
}

/** A bot author cannot fill the human template, so `template-incomplete` is suppressed for them. */
export function isBotAuthor(pr: Pick<PullRequest, "author">): boolean {
	return pr.author.is_bot === true || pr.author.login.endsWith("[bot]");
}

function isBotCommit(commit: Commit): boolean {
	return commit.authorEmail.endsWith(BOT_EMAIL_SUFFIX) && BOT_NAMES.includes(commit.authorName);
}

/** Every `Signed-off-by:` trailer value in a commit message, key matched case-insensitively as git does. */
export function signoffValues(message: string): string[] {
	const values: string[] = [];
	for (const line of message.split(/\r?\n/)) {
		const m = /^[ \t]*signed-off-by[ \t]*:[ \t]*(.*?)[ \t]*$/i.exec(line);
		if (m && m[1] !== undefined && m[1] !== "") values.push(m[1]);
	}
	return values;
}

/** Split a trailer value `Name <email>` the way `dco.yml`'s SOB_RE does; null if it does not parse. */
export function parseSignoff(value: string): { name: string; email: string } | null {
	const m = /^(.*\S)\s*<(.*)>\s*$/.exec(value);
	if (!m || m[1] === undefined || m[2] === undefined) return null;
	return { name: m[1], email: m[2] };
}

export interface UnsignedCommit {
	readonly sha: string;
	readonly reason: "no-trailer" | "mismatch";
}

/**
 * The commits that would fail DCO, by the same rule `dco.yml` applies. Merge and
 * bot commits are skipped (never reported). A commit passes if any of its
 * `Signed-off-by` trailers has a name equal to the author name (exact) and an
 * email equal to the author email (case-insensitive).
 */
export function unsignedCommits(commits: readonly Commit[]): UnsignedCommit[] {
	const failures: UnsignedCommit[] = [];
	for (const commit of commits) {
		if (commit.parents > 1) continue; // merge: not the contributor's to sign
		if (isBotCommit(commit)) continue; // bot: skipped FIRST, before any trailer is read
		const values = signoffValues(commit.message);
		if (values.length === 0) {
			failures.push({ sha: commit.sha, reason: "no-trailer" });
			continue;
		}
		const matched = values.some((value) => {
			const parsed = parseSignoff(value);
			return (
				parsed !== null &&
				parsed.name === commit.authorName &&
				parsed.email.toLowerCase() === commit.authorEmail.toLowerCase()
			);
		});
		if (!matched) failures.push({ sha: commit.sha, reason: "mismatch" });
	}
	return failures;
}

function isGreenOnMain(name: string, mainChecks: readonly Check[]): boolean {
	let sawPass = false;
	for (const check of mainChecks) {
		if (check.name !== name) continue;
		if (check.bucket === "fail") return false; // a red run on main means it is not reliably green
		if (check.bucket === "pass") sawPass = true;
	}
	return sawPass;
}

/**
 * The check-derived findings for a PR. For each failing check:
 *   - not in the required set          -> `not-required-red` (fork/GHCR/Vercel; does not block)
 *   - required and green on `main`     -> `ci-flaky`         (the #24 shell case)
 *   - required and not green on `main` -> `ci-red`           (a real regression)
 * `not-required-red` is decided FIRST: a non-required check that is green on main
 * is still the fork limitation, not a flake.
 */
export function classifyChecks(checks: readonly Check[], mainChecks: readonly Check[]): Set<Finding> {
	const findings = new Set<Finding>();
	for (const check of checks) {
		if (check.bucket !== "fail") continue;
		if (!REQUIRED_SET.has(check.name)) {
			findings.add("not-required-red");
		} else if (isGreenOnMain(check.name, mainChecks)) {
			findings.add("ci-flaky");
		} else {
			findings.add("ci-red");
		}
	}
	return findings;
}

/**
 * The ordered findings for one pull request. Pure: the same inputs give the same
 * output, which is what lets the supervisor act on the JSON without re-deciding.
 */
export function classifyPr(
	pr: PullRequest,
	checks: readonly Check[],
	commits: readonly Commit[],
	mainChecks: readonly Check[],
): Finding[] {
	const found = new Set<Finding>();

	if (unsignedCommits(commits).length > 0) found.add("missing-dco");
	if (!isBotAuthor(pr) && !hasChecklist(pr.body)) found.add("template-incomplete");
	for (const finding of classifyChecks(checks, mainChecks)) found.add(finding);
	if (sizeBucket(pr.additions + pr.deletions) === "XL") found.add("size-xl");
	found.add(pr.isDraft ? "draft" : "ready-for-review");

	return FINDING_ORDER.filter((finding) => found.has(finding));
}

export interface LabelChange {
	readonly add: readonly string[];
	readonly remove: readonly string[];
}

/** The size label a PR should carry, and the other four to strip if present. Never touches non-size labels. */
export function prLabelChange(pr: Pick<PullRequest, "additions" | "deletions" | "labels">): LabelChange {
	const want = sizeLabel(pr.additions + pr.deletions);
	const current = new Set(pr.labels.map((label) => label.name));
	return {
		add: current.has(want) ? [] : [want],
		remove: SIZE_LABELS.filter((size) => size !== want && current.has(size)),
	};
}

/** `needs-triage` iff the issue carries no area label and does not already have it. Never removes labels. */
export function issueLabelChange(issue: Pick<Issue, "labels">): LabelChange {
	const current = new Set(issue.labels.map((label) => label.name));
	const hasArea = AREA_LABELS.some((area) => current.has(area));
	const needsTriage = !hasArea && !current.has("needs-triage");
	return { add: needsTriage ? ["needs-triage"] : [], remove: [] };
}

// ---------------------------------------------------------------------------
// Comment assembly and idempotence.
// ---------------------------------------------------------------------------

/** Every triage marker present across a PR's existing comment bodies. */
export function markersIn(commentBodies: readonly string[]): Set<Finding> {
	const present = new Set<Finding>();
	const re = /<!--\s*ezil-triage:\s*([a-z-]+)\s*-->/g;
	for (const body of commentBodies) {
		let m: RegExpExecArray | null;
		re.lastIndex = 0;
		while ((m = re.exec(body)) !== null) {
			const name = m[1];
			if (name !== undefined && (FINDING_ORDER as readonly string[]).includes(name)) {
				present.add(name as Finding);
			}
		}
	}
	return present;
}

/** The comment findings that should still be posted: those with a body, whose marker is not already present. */
export function findingsToPost(findings: readonly Finding[], alreadyPosted: ReadonlySet<Finding>): CommentFinding[] {
	return findings.filter((finding): finding is CommentFinding => isCommentFinding(finding) && !alreadyPosted.has(finding));
}

/** One comment merging every finding's section, each behind its marker. Null when there is nothing to say. */
export function buildComment(findings: readonly Finding[]): string | null {
	const sections = FINDING_ORDER.filter(
		(finding): finding is CommentFinding => findings.includes(finding) && isCommentFinding(finding),
	).map((finding) => `${marker(finding)}\n${TEMPLATES[finding]}`);
	if (sections.length === 0) return null;
	return `${sections.join("\n\n")}\n\n${COMMENT_FOOTER}`;
}

// ---------------------------------------------------------------------------
// The action plan: a closed union, so destruction is unrepresentable.
// ---------------------------------------------------------------------------

export type ActionKind = "comment" | "add-label" | "remove-label";

export interface Action {
	readonly kind: ActionKind;
	readonly target: "pr" | "issue";
	readonly number: number;
	/** For `comment`. */
	readonly body?: string;
	/** For `add-label` / `remove-label`. */
	readonly label?: string;
}

export interface PrTriage {
	readonly number: number;
	readonly title: string;
	readonly findings: readonly Finding[];
	readonly size: string;
	readonly labelsToAdd: readonly string[];
	readonly labelsToRemove: readonly string[];
	/** Names of checks in bucket `fail`, so the supervisor can see WHICH contexts are red. */
	readonly redChecks: readonly string[];
	/** The comment that would be posted this run (markers already present are excluded), or null. */
	readonly wouldPost: string | null;
}

export interface IssueTriage {
	readonly number: number;
	readonly title: string;
	readonly findings: readonly string[];
	readonly labelsToAdd: readonly string[];
	readonly labelsToRemove: readonly string[];
	readonly wouldPost: string | null;
}

/** Turn triage results into the flat, closed-union action list `applyActions` executes. */
export function planActions(prs: readonly PrTriage[], issues: readonly IssueTriage[]): Action[] {
	const actions: Action[] = [];
	for (const pr of prs) {
		if (pr.wouldPost !== null) actions.push({ kind: "comment", target: "pr", number: pr.number, body: pr.wouldPost });
		for (const label of pr.labelsToAdd) actions.push({ kind: "add-label", target: "pr", number: pr.number, label });
		for (const label of pr.labelsToRemove) actions.push({ kind: "remove-label", target: "pr", number: pr.number, label });
	}
	for (const issue of issues) {
		if (issue.wouldPost !== null)
			actions.push({ kind: "comment", target: "issue", number: issue.number, body: issue.wouldPost });
		for (const label of issue.labelsToAdd) actions.push({ kind: "add-label", target: "issue", number: issue.number, label });
		for (const label of issue.labelsToRemove)
			actions.push({ kind: "remove-label", target: "issue", number: issue.number, label });
	}
	return actions;
}

/**
 * The exact `gh` argument vector for one action. The switch is total over
 * `ActionKind`, and there is deliberately no branch that could `close`, `merge`,
 * `ready`, `review` or `rerun` -- the subcommands are only `comment` and `edit`.
 * Pure and exported so a test can assert that property over every action.
 */
export function argsFor(action: Action, repo: string): string[] {
	const noun = action.target; // "pr" | "issue"
	switch (action.kind) {
		case "comment":
			return [noun, "comment", String(action.number), "-R", repo, "--body", action.body ?? ""];
		case "add-label":
			return [noun, "edit", String(action.number), "-R", repo, "--add-label", action.label ?? ""];
		case "remove-label":
			return [noun, "edit", String(action.number), "-R", repo, "--remove-label", action.label ?? ""];
	}
}

/**
 * Execute the plan -- but only when `post` is true. In a dry run this is a
 * no-op, which is the whole safety property: the default cannot write. `run` is
 * injected so a test proves the gate (zero calls dry, N calls posting) without a
 * real `gh` ever being reachable.
 */
export async function applyActions(
	actions: readonly Action[],
	opts: { post: boolean; repo: string; run: (args: string[]) => Promise<void> },
): Promise<void> {
	if (!opts.post) return;
	for (const action of actions) {
		await opts.run(argsFor(action, opts.repo));
	}
}

// ---------------------------------------------------------------------------
// Normalisers from raw `gh` shapes to the typed inputs above.
// ---------------------------------------------------------------------------

function asBucket(value: unknown): Bucket {
	if (typeof value === "string" && BUCKETS.has(value)) return value as Bucket;
	throw new Error(`unrecognised check bucket ${JSON.stringify(value)}; a gh upgrade may have changed the vocabulary.`);
}

/** From `gh pr checks --json name,bucket,state`. */
export function normalizePrChecks(raw: unknown): Check[] {
	if (!Array.isArray(raw)) throw new Error("pr checks: expected a JSON array.");
	return raw.map((entry) => {
		const row = entry as { name?: unknown; bucket?: unknown };
		if (typeof row.name !== "string") throw new Error("pr checks: a row has no string name.");
		return { name: row.name, bucket: asBucket(row.bucket) };
	});
}

/** conclusion+status from the REST check-runs API, reduced to a bucket. */
function conclusionToBucket(conclusion: unknown, status: unknown): Bucket {
	if (status !== "completed") return "pending";
	switch (conclusion) {
		case "success":
			return "pass";
		case "failure":
		case "timed_out":
		case "action_required":
		case "startup_failure":
			return "fail";
		case "cancelled":
			return "cancel";
		case "skipped":
		case "neutral":
			return "skipping";
		default:
			return "pending";
	}
}

/** From `gh api repos/{repo}/commits/{ref}/check-runs`. */
export function normalizeMainChecks(raw: unknown): Check[] {
	const runs = (raw as { check_runs?: unknown }).check_runs;
	if (!Array.isArray(runs)) throw new Error("main check-runs: expected an object with a check_runs array.");
	return runs.map((entry) => {
		const row = entry as { name?: unknown; conclusion?: unknown; status?: unknown };
		if (typeof row.name !== "string") throw new Error("main check-runs: a run has no string name.");
		return { name: row.name, bucket: conclusionToBucket(row.conclusion, row.status) };
	});
}

/** From `gh api repos/{repo}/pulls/{n}/commits`. */
export function normalizeCommits(raw: unknown): Commit[] {
	if (!Array.isArray(raw)) throw new Error("pr commits: expected a JSON array.");
	return raw.map((entry) => {
		const row = entry as {
			sha?: unknown;
			commit?: { message?: unknown; author?: { name?: unknown; email?: unknown } };
			parents?: unknown;
		};
		const author = row.commit?.author;
		if (typeof row.sha !== "string") throw new Error("pr commits: a commit has no sha.");
		if (typeof author?.name !== "string" || typeof author.email !== "string")
			throw new Error(`pr commits: commit ${row.sha} has no author name/email.`);
		return {
			sha: row.sha,
			authorName: author.name,
			authorEmail: author.email,
			message: typeof row.commit?.message === "string" ? row.commit.message : "",
			parents: Array.isArray(row.parents) ? row.parents.length : 1,
		};
	});
}

// ---------------------------------------------------------------------------
// The cursor: machine state, outside the repository.
// ---------------------------------------------------------------------------

export interface Cursor {
	readonly since: string;
	readonly updatedAt: string;
}

export function cursorPath(): string {
	const base = process.env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache");
	return join(base, "ezil-os", "triage-cursor.json");
}

/**
 * Read the cursor. A missing file is "first run" (null). A file that exists but
 * does not parse is a hard error, never a silent fall-through to null: a
 * corrupt cursor that quietly reprocessed everything would look identical to a
 * healthy first run.
 */
export function readCursor(path: string): Cursor | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (cause) {
		throw new Error(`cursor at ${path} is present but not JSON (${String(cause)}); refusing to treat it as a first run.`);
	}
	const row = raw as { since?: unknown; updatedAt?: unknown };
	if (typeof row.since !== "string" || typeof row.updatedAt !== "string")
		throw new Error(`cursor at ${path} is malformed; expected {since, updatedAt} strings.`);
	return { since: row.since, updatedAt: row.updatedAt };
}

function writeCursor(path: string, cursor: Cursor): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cursor, null, 2)}\n`);
}

/** A row updated at or after `since` is in scope. A null `since` (first run) is in scope for everything. */
export function inScope(updatedAt: string, since: string | null): boolean {
	return since === null || updatedAt >= since;
}

// ---------------------------------------------------------------------------
// gh I/O. Every call is a typed failure on trouble, never a silent empty list.
// ---------------------------------------------------------------------------

export class GhError extends Error {}

async function sh(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	const exitCode = await proc.exited;
	return { stdout, stderr, exitCode };
}

/** A `gh` call whose stdout is JSON; a non-zero exit is a GhError, never an empty result. */
async function ghJson<T>(args: string[]): Promise<T> {
	const { stdout, stderr, exitCode } = await sh(args);
	if (exitCode !== 0) throw new GhError(`gh ${args.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
	try {
		return JSON.parse(stdout) as T;
	} catch (cause) {
		throw new GhError(`gh ${args.join(" ")} did not return JSON: ${String(cause)}`);
	}
}

/**
 * `gh pr checks --json` is the one call keyed on parseable stdout rather than
 * exit code: measured 2026-09-05 it exits 0 with `--json` even when a check is
 * failing or pending, but the TTY form exits non-zero for both, and a gh upgrade
 * could bring that behaviour to `--json`. So: JSON on stdout is success (even an
 * empty array); a genuinely check-less PR reports "no checks" on stderr and is an
 * empty list, not an error; anything else is a GhError.
 */
async function ghChecks(repo: string, number: number): Promise<Check[]> {
	const { stdout, stderr } = await sh(["pr", "checks", String(number), "-R", repo, "--json", "name,bucket,state"]);
	const trimmed = stdout.trim();
	if (trimmed !== "") {
		try {
			return normalizePrChecks(JSON.parse(trimmed));
		} catch (cause) {
			throw new GhError(`pr checks ${number}: unparseable output: ${String(cause)}`);
		}
	}
	if (/no check/i.test(stderr)) return []; // a PR with no checks: empty is the truth
	throw new GhError(`pr checks ${number} produced no JSON: ${stderr.trim()}`);
}

interface Fetchers {
	openPrs(repo: string): Promise<PullRequest[]>;
	prChecks(repo: string, number: number): Promise<Check[]>;
	prCommits(repo: string, number: number): Promise<Commit[]>;
	prComments(repo: string, number: number): Promise<string[]>;
	mainChecks(repo: string): Promise<Check[]>;
	openIssues(repo: string): Promise<Issue[]>;
	requiredContexts(repo: string): Promise<string[] | null>;
}

const liveFetchers: Fetchers = {
	openPrs: (repo) =>
		ghJson<PullRequest[]>([
			"pr",
			"list",
			"-R",
			repo,
			"--state",
			"open",
			"--limit",
			"100",
			"--json",
			"number,title,author,isDraft,labels,additions,deletions,headRefName,body,updatedAt",
		]),
	prChecks: (repo, number) => ghChecks(repo, number),
	prCommits: async (repo, number) =>
		normalizeCommits(await ghJson<unknown>(["api", `repos/${repo}/pulls/${number}/commits?per_page=100`])),
	prComments: async (repo, number) => {
		const view = await ghJson<{ comments?: { body?: unknown }[] }>([
			"pr",
			"view",
			String(number),
			"-R",
			repo,
			"--json",
			"comments",
		]);
		return (view.comments ?? []).map((c) => (typeof c.body === "string" ? c.body : ""));
	},
	mainChecks: async (repo) =>
		normalizeMainChecks(await ghJson<unknown>(["api", `repos/${repo}/commits/main/check-runs?per_page=100`])),
	openIssues: (repo) =>
		ghJson<Issue[]>([
			"issue",
			"list",
			"-R",
			repo,
			"--state",
			"open",
			"--limit",
			"100",
			"--json",
			"number,title,labels,body,updatedAt",
		]),
	requiredContexts: async (repo) => {
		try {
			const rulesets = await ghJson<{ id: number }[]>(["api", `repos/${repo}/rulesets`]);
			for (const rs of rulesets) {
				const detail = await ghJson<{
					rules?: { type?: string; parameters?: { required_status_checks?: { context?: string }[] } }[];
				}>(["api", `repos/${repo}/rulesets/${rs.id}`]);
				const rule = (detail.rules ?? []).find((r) => r.type === "required_status_checks");
				const contexts = rule?.parameters?.required_status_checks;
				if (contexts) return contexts.map((c) => c.context ?? "").filter((c) => c !== "");
			}
			return null;
		} catch {
			return null; // the cross-check is advisory; a token without ruleset scope must not break triage
		}
	},
};

// ---------------------------------------------------------------------------
// Orchestration and the JSON summary.
// ---------------------------------------------------------------------------

export interface Summary {
	readonly repo: string;
	readonly since: string | null;
	readonly cursor: { readonly path: string; readonly since: string | null; readonly advanced: boolean };
	readonly prs: readonly PrTriage[];
	readonly issues: readonly IssueTriage[];
	readonly requiredContextsDrift: readonly string[] | null;
	readonly counts: {
		readonly openPrs: number;
		readonly openIssues: number;
		readonly prsWithFindings: number;
		readonly findings: Readonly<Record<string, number>>;
		readonly wouldComment: number;
		readonly wouldAddLabels: number;
		readonly wouldRemoveLabels: number;
	};
}

export interface RunOptions {
	readonly repo: string;
	readonly since: string | null;
	readonly post: boolean;
}

/**
 * Gather, classify, plan, and (only under `post`) apply. Returns the summary and
 * the human-readable lines; the caller decides where each goes. Kept as one
 * function taking injected fetchers so the pure core stays testable and the CLI
 * shell below is thin.
 */
export async function run(
	options: RunOptions,
	fetchers: Fetchers,
	apply: (actions: readonly Action[]) => Promise<void>,
): Promise<{ summary: Summary; lines: string[] }> {
	const { repo, since, post } = options;
	const lines: string[] = [];

	const [allPrs, allIssues, mainChecks, liveRequired] = await Promise.all([
		fetchers.openPrs(repo),
		fetchers.openIssues(repo),
		fetchers.mainChecks(repo),
		fetchers.requiredContexts(repo),
	]);

	const prs = allPrs.filter((pr) => inScope(pr.updatedAt, since));
	const issues = allIssues.filter((issue) => inScope(issue.updatedAt, since));

	const prTriages: PrTriage[] = [];
	for (const pr of prs) {
		const [checks, commits, comments] = await Promise.all([
			fetchers.prChecks(repo, pr.number),
			fetchers.prCommits(repo, pr.number),
			fetchers.prComments(repo, pr.number),
		]);
		const findings = classifyPr(pr, checks, commits, mainChecks);
		const labels = prLabelChange(pr);
		const toPost = findingsToPost(findings, markersIn(comments));
		prTriages.push({
			number: pr.number,
			title: pr.title,
			findings,
			size: sizeLabel(pr.additions + pr.deletions),
			labelsToAdd: labels.add,
			labelsToRemove: labels.remove,
			redChecks: checks.filter((c) => c.bucket === "fail").map((c) => c.name),
			wouldPost: buildComment(toPost),
		});
	}

	const issueTriages: IssueTriage[] = issues.map((issue) => {
		const labels = issueLabelChange(issue);
		return {
			number: issue.number,
			title: issue.title,
			findings: labels.add.includes("needs-triage") ? ["needs-triage"] : [],
			labelsToAdd: labels.add,
			labelsToRemove: labels.remove,
			wouldPost: null,
		};
	});

	const actions = planActions(prTriages, issueTriages);
	await apply(actions);

	// Cross-check the mirrored constant against the live ruleset.
	let drift: string[] | null = null;
	if (liveRequired !== null) {
		const live = new Set(liveRequired);
		const constant = new Set(REQUIRED_CONTEXTS);
		const missing = liveRequired.filter((c) => !constant.has(c));
		const extra = REQUIRED_CONTEXTS.filter((c) => !live.has(c));
		if (missing.length > 0 || extra.length > 0) {
			drift = [
				...missing.map((c) => `+ live requires ${JSON.stringify(c)} (not in REQUIRED_CONTEXTS)`),
				...extra.map((c) => `- REQUIRED_CONTEXTS has ${JSON.stringify(c)} (no longer required live)`),
			];
			lines.push(`WARNING: REQUIRED_CONTEXTS has drifted from ruleset on ${repo}:`);
			for (const d of drift) lines.push(`  ${d}`);
		}
	}

	const findingCounts: Record<string, number> = {};
	for (const pr of prTriages) for (const f of pr.findings) findingCounts[f] = (findingCounts[f] ?? 0) + 1;

	const commentCount = actions.filter((a) => a.kind === "comment").length;
	const addCount = actions.filter((a) => a.kind === "add-label").length;
	const removeCount = actions.filter((a) => a.kind === "remove-label").length;

	const summary: Summary = {
		repo,
		since,
		cursor: { path: cursorPath(), since, advanced: post },
		prs: prTriages,
		issues: issueTriages,
		requiredContextsDrift: drift,
		counts: {
			openPrs: prs.length,
			openIssues: issues.length,
			prsWithFindings: prTriages.filter((pr) => pr.findings.some((f) => f !== "ready-for-review" && f !== "draft")).length,
			findings: findingCounts,
			wouldComment: commentCount,
			wouldAddLabels: addCount,
			wouldRemoveLabels: removeCount,
		},
	};

	for (const pr of prTriages) {
		const verb = post ? (pr.wouldPost ? "posted" : "no comment") : pr.wouldPost ? "would post" : "no comment";
		lines.push(
			`PR #${pr.number} [${pr.size}] ${pr.findings.join(", ") || "(none)"} — ${verb}` +
				(pr.labelsToAdd.length || pr.labelsToRemove.length
					? `; labels +[${pr.labelsToAdd.join(", ")}] -[${pr.labelsToRemove.join(", ")}]`
					: ""),
		);
	}
	for (const issue of issueTriages) {
		lines.push(
			`issue #${issue.number} ${issue.findings.join(", ") || "(no area label needed)"} — labels +[${issue.labelsToAdd.join(", ")}]`,
		);
	}
	lines.push(
		`${post ? "POSTED" : "dry run"}: ${prs.length} PR(s), ${issues.length} issue(s); ` +
			`${commentCount} comment(s), ${addCount} label add(s), ${removeCount} label removal(s).`,
	);

	return { summary, lines };
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

export interface CliArgs {
	readonly repo: string;
	readonly since: string | null;
	readonly post: boolean;
	readonly help: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
	let repo = "EZiLHQ/ezil-os";
	let since: string | null = null;
	let post = false;
	let help = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--repo") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error("--repo needs an owner/name value.");
			repo = value;
			i += 1;
		} else if (arg === "--since") {
			const value = argv[i + 1];
			if (value === undefined) throw new Error("--since needs an ISO timestamp.");
			since = value;
			i += 1;
		} else if (arg === "--post") {
			post = true;
		} else if (arg === "--help" || arg === "-h") {
			help = true;
		} else {
			throw new Error(`unknown argument ${JSON.stringify(arg)}. Flags: --repo <owner/name>, --since <iso>, --post.`);
		}
	}
	return { repo, since, post, help };
}

if (import.meta.main) {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		process.stderr.write(
			"triage.ts — deterministic triage over open PRs and issues.\n" +
				"  --repo <owner/name>   default EZiLHQ/ezil-os\n" +
				"  --since <iso>         override the cursor; default reads the cursor, else all\n" +
				"  --post                the ONLY flag that writes (labels + comments). Default is a dry run.\n" +
				`  cursor: ${cursorPath()} (outside the repository)\n`,
		);
		process.exit(0);
	}

	const path = cursorPath();
	const since = args.since ?? readCursor(path)?.since ?? null;

	const { summary, lines } = await run({ repo: args.repo, since, post: args.post }, liveFetchers, (actions) =>
		applyActions(actions, {
			post: args.post,
			repo: args.repo,
			run: async (ghArgs) => {
				const { stderr, exitCode } = await sh(ghArgs);
				if (exitCode !== 0) throw new GhError(`gh ${ghArgs.join(" ")} exited ${exitCode}: ${stderr.trim()}`);
			},
		}),
	);

	// Only --post advances the cursor, and only after acting. A dry run leaves no trace.
	if (args.post) writeCursor(path, { since: new Date().toISOString(), updatedAt: new Date().toISOString() });

	for (const line of lines) process.stderr.write(`${line}\n`);
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
