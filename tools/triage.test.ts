/**
 * Tests for the deterministic triage core.
 *
 * ## Fixture provenance (a `gh` upgrade can invalidate these)
 *
 * All shapes are captured from real `gh` output on `EZiLHQ/ezil-os` (2026-09-05):
 *   - `main-checks.json`  — the real `gh api repos/EZiLHQ/ezil-os/commits/main/check-runs`
 *     response, trimmed to the fifteen required contexts plus `container`/`local`,
 *     all `success` (main was green). This is the "green on main" side of the flaky
 *     discriminator.
 *   - `pr-list.json`      — PRs #33 and #34 are the real open Dependabot PRs
 *     (`gh pr list --json ...`); #101/#102/#103 are synthesized to the same shape
 *     to exercise human-authored findings (draft-XL, ready-M-with-checklist, XS)
 *     that no currently-open PR happens to show.
 *   - `pr-checks-*.json`  — the shape of `gh pr checks --json name,bucket,state`.
 *     The failing legs are set to the MEASURED flake pattern: PRs #24/#31 carried a
 *     genuinely flaky `shell (…)` leg that was green on `main` for the same name
 *     (round INTAKE §B3 correction 1). `pr-checks-red.json` additionally carries the
 *     `container`/`local`/`Vercel` reds that a fork PR always shows.
 *   - `pr-commits-unsigned.json` — the `gh api repos/.../pulls/{n}/commits` shape.
 *     Commit #1 is the real Dependabot ident (name `dependabot[bot]`, a
 *     `@users.noreply.github.com` email) carrying a `Signed-off-by` whose email is
 *     `support@github.com` — the exact mismatch `dco.yml` documents, which MUST be
 *     bot-skipped rather than failed.
 *   - `issue-list.json`   — `gh issue list -R EZiLHQ/ezil-os --state all --json
 *     number,title,author,labels,body,updatedAt` returns `[]` (measured 2026-09-05:
 *     the repository has never had an issue opened, open or closed, not just none
 *     open today). There is nothing real to capture, so all five entries are
 *     synthesized to the `--json` shape `liveFetchers.openIssues` actually requests
 *     (`--state open`); #201/#202/#203/#204 exercise the human-authored area-label
 *     rule (no labels, an area label, an existing `needs-triage`, a non-area label)
 *     and are marked human (`is_bot: false`). #205 is the bot-authored entry: its
 *     `author` shape (`{ login: "app/dependabot", is_bot: true }`) is the SAME real
 *     shape already captured for PRs #33/#34 in `pr-list.json` from this
 *     repository's actual open Dependabot PRs — GitHub renders an App-based bot
 *     account this way over `gh ... --json author` (confirmed against a live bot
 *     account 2026-09-05: `gh issue list -R cli/cli --json author` returns
 *     `{"is_bot":true,"login":"app/cli-triage"}`, no `[bot]` suffix), which is
 *     exactly the case `isBotAuthor`'s `is_bot` check exists for and the case
 *     `.github/workflows/triage-label.yml`'s webhook-only `login.endsWith("[bot]")`
 *     check cannot see. Dependabot itself does not open issues today, so #205 is a
 *     stand-in for "some bot account, someday" rather than a specific known case.
 *
 * The classifiers are pure, so these fixtures are the whole story: the mutation
 * proof for the flaky discriminator is `classifyChecks(flaky, [])` below, and the
 * manual version (make `isGreenOnMain` ignore its argument) is recorded in the
 * row's report.
 */

import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import {
	AREA_LABELS,
	FINDING_ORDER,
	REQUIRED_CONTEXTS,
	SIZE_LABELS,
	TEMPLATES,
	applyActions,
	argsFor,
	buildComment,
	classifyChecks,
	classifyPr,
	findingsToPost,
	hasChecklist,
	inScope,
	isBotAuthor,
	issueLabelChange,
	marker,
	markersIn,
	normalizeCommits,
	normalizeMainChecks,
	normalizePrChecks,
	parseArgs,
	parseSignoff,
	planActions,
	prLabelChange,
	readCursor,
	run,
	signoffValues,
	sizeBucket,
	unsignedCommits,
	type Action,
	type Check,
	type Commit,
	type Finding,
	type Issue,
	type IssueTriage,
	type PrTriage,
	type PullRequest,
} from "./triage.ts";

function fx<T>(name: string): T {
	return JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "triage", name), "utf8")) as T;
}

const prList = fx<PullRequest[]>("pr-list.json");
const issueList = fx<Issue[]>("issue-list.json");
const mainChecks = normalizeMainChecks(fx("main-checks.json"));
const flakyChecks = normalizePrChecks(fx("pr-checks-flaky.json"));
const redChecks = normalizePrChecks(fx("pr-checks-red.json"));
const commits = normalizeCommits(fx("pr-commits-unsigned.json"));

function pr(number: number): PullRequest {
	const found = prList.find((p) => p.number === number);
	if (found === undefined) throw new Error(`fixture pr-list.json has no PR #${number}`);
	return found;
}

/** The commits that are skipped or already ok — a PR built from these has no DCO problem. */
const signedSubset = commits.filter((c) => ["b0d472", "111111", "444444", "555555"].some((p) => c.sha.startsWith(p)));

// ─────────────────────────────────────────────────────────────────────────────
describe("size buckets, at every boundary", () => {
	it("maps the ranges the brief names", () => {
		expect(sizeBucket(0)).toBe("XS");
		expect(sizeBucket(20)).toBe("XS");
		expect(sizeBucket(21)).toBe("S");
		expect(sizeBucket(100)).toBe("S");
		expect(sizeBucket(101)).toBe("M");
		expect(sizeBucket(400)).toBe("M");
		expect(sizeBucket(401)).toBe("L");
		expect(sizeBucket(1000)).toBe("L");
		expect(sizeBucket(1001)).toBe("XL");
		expect(sizeBucket(50000)).toBe("XL");
	});
});

describe("PR size labels: add the right one, strip the other four", () => {
	it("adds the computed label when none is present (#33 → size/S)", () => {
		const change = prLabelChange(pr(33)); // 40 + 36 = 76
		expect(change.add).toEqual(["size/S"]);
		expect(change.remove).toEqual([]);
	});

	it("removes a stale size label and adds the correct one (#102 carries size/L, is 200 → M)", () => {
		const change = prLabelChange(pr(102)); // 120 + 80 = 200, labels include size/L
		expect(change.add).toEqual(["size/M"]);
		expect(change.remove).toEqual(["size/L"]);
	});

	it("adds nothing when the correct label is already present, and never touches a non-size label", () => {
		const change = prLabelChange({ additions: 10, deletions: 5, labels: [{ name: "size/XS" }, { name: "shell" }] });
		expect(change.add).toEqual([]);
		expect(change.remove).toEqual([]); // shell is not a size label
	});

	it("every size label it may add is one of the five, and no other", () => {
		for (const total of [0, 21, 101, 401, 1001]) {
			const change = prLabelChange({ additions: total, deletions: 0, labels: [] });
			for (const label of change.add) expect(SIZE_LABELS).toContain(label);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("template completeness: a checkbox anywhere means the template is present", () => {
	it("fires for a human PR whose body has no checkbox", () => {
		expect(hasChecklist(pr(101).body)).toBe(false);
		expect(classifyPr(pr(101), [], signedSubset, mainChecks)).toContain("template-incomplete");
	});

	it("does NOT fire for a human PR that kept the checklist (positive control)", () => {
		expect(hasChecklist(pr(102).body)).toBe(true);
		expect(classifyPr(pr(102), [], signedSubset, mainChecks)).not.toContain("template-incomplete");
	});

	it("is SUPPRESSED for a bot author even with no checkbox — the deviation from the brief's unconditional rule", () => {
		expect(isBotAuthor(pr(33))).toBe(true);
		expect(hasChecklist(pr(33).body)).toBe(false);
		expect(classifyPr(pr(33), [], [], mainChecks)).not.toContain("template-incomplete");
	});

	it("recognises `*`-bulleted and indented checkboxes too, and rejects prose", () => {
		expect(hasChecklist("* [ ] a task")).toBe(true);
		expect(hasChecklist("  - [x] done")).toBe(true);
		expect(hasChecklist("just a paragraph with [brackets] but no task")).toBe(false);
		expect(hasChecklist("")).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("draft vs ready-for-review — exactly one always fires", () => {
	it("draft PR", () => {
		const findings = classifyPr(pr(101), [], signedSubset, mainChecks);
		expect(findings).toContain("draft");
		expect(findings).not.toContain("ready-for-review");
	});

	it("ready PR", () => {
		const findings = classifyPr(pr(102), [], signedSubset, mainChecks);
		expect(findings).toContain("ready-for-review");
		expect(findings).not.toContain("draft");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the check discriminator: not-required-red > ci-flaky > ci-red", () => {
	it("a required leg red on the PR but green on main is ci-flaky, not ci-red (the #24 case)", () => {
		const findings = classifyChecks(flakyChecks, mainChecks);
		expect([...findings]).toEqual(["ci-flaky"]);
		expect(findings.has("ci-red")).toBe(false);
	});

	it("MUTATION: the same red leg with no main baseline is ci-red — proving mainChecks is load-bearing", () => {
		const findings = classifyChecks(flakyChecks, []);
		expect([...findings]).toEqual(["ci-red"]);
		expect(findings.has("ci-flaky")).toBe(false);
	});

	it("a non-required leg red on the PR but green on main is not-required-red, NOT ci-flaky (precedence)", () => {
		const containerOnly: Check[] = [{ name: "container (real image)", bucket: "fail" }];
		const findings = classifyChecks(containerOnly, mainChecks); // container IS green on main
		expect([...findings]).toEqual(["not-required-red"]);
		expect(findings.has("ci-flaky")).toBe(false);
	});

	it("positive control: a required leg red-on-PR/green-on-main from the SAME main is ci-flaky", () => {
		const shellOnly: Check[] = [{ name: "shell (bundle check + browser suites) (ubuntu-latest)", bucket: "fail" }];
		expect([...classifyChecks(shellOnly, mainChecks)]).toEqual(["ci-flaky"]);
	});

	it("the fork PR shape: a real required regression is ci-red while container/local/Vercel are not-required-red", () => {
		// app leg failing on main too (a broken-main scenario) so it is a genuine ci-red, not a flake.
		const brokenMain = mainChecks.map((c) =>
			c.name === "app (typecheck + unit) (ubuntu-latest)" ? ({ name: c.name, bucket: "fail" as const }) : c,
		);
		const findings = classifyChecks(redChecks, brokenMain);
		expect([...findings].sort()).toEqual(["ci-red", "not-required-red"]);
	});

	it("skipping/pending/cancel legs never count as failures (positive control on bucket)", () => {
		const noisy: Check[] = [
			{ name: "tools (typecheck + unit)", bucket: "pending" },
			{ name: "app (typecheck + unit) (macos-latest)", bucket: "skipping" },
			{ name: "DCO", bucket: "cancel" },
		];
		expect([...classifyChecks(noisy, mainChecks)]).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("DCO — the exact rule from dco.yml", () => {
	it("flags exactly the two human failures + the case-sensitive-name mismatch, and nothing else", () => {
		const failures = unsignedCommits(commits);
		const shas = failures.map((f) => f.sha.slice(0, 6)).sort();
		expect(shas).toEqual(["222222", "333333", "666666"]);
	});

	it("distinguishes a missing trailer from a mismatched one", () => {
		const byPrefix = (p: string) => unsignedCommits(commits).find((f) => f.sha.startsWith(p));
		expect(byPrefix("222222")?.reason).toBe("no-trailer");
		expect(byPrefix("333333")?.reason).toBe("mismatch"); // email old vs new
		expect(byPrefix("666666")?.reason).toBe("mismatch"); // name "Bob" vs author "bob", case-sensitive
	});

	it("the Dependabot commit with a mismatched trailer email is SKIPPED as a bot, not failed (the dco.yml trap)", () => {
		const bot = commits.find((c) => c.sha.startsWith("b0d472"));
		expect(bot?.authorName).toBe("dependabot[bot]");
		// The trailer email (support@github.com) does not match the author email — an
		// "is a trailer missing?" gate would fail it. It must be absent from failures.
		expect(unsignedCommits(commits).some((f) => f.sha.startsWith("b0d472"))).toBe(false);
	});

	it("a merge commit is skipped even with no trailer (positive control: it is unsigned)", () => {
		const merge = commits.find((c) => c.sha.startsWith("444444"));
		expect(merge?.parents).toBe(2);
		expect(signoffValues(merge?.message ?? "")).toEqual([]);
		expect(unsignedCommits(commits).some((f) => f.sha.startsWith("444444"))).toBe(false);
	});

	it("email matches case-insensitively but name matches exactly", () => {
		const caseOk = commits.find((c) => c.sha.startsWith("555555"));
		expect(caseOk?.authorEmail).toBe("Case@Example.COM"); // author upper, trailer lower → still ok
		expect(unsignedCommits(commits).some((f) => f.sha.startsWith("555555"))).toBe(false);
	});

	it("a correctly-signed set has no failures (positive control that the rule does not reject everything)", () => {
		expect(unsignedCommits(signedSubset)).toEqual([]);
	});

	it("missing-dco fires on a PR with any unsigned commit and not on a clean one", () => {
		expect(classifyPr(pr(102), [], commits, mainChecks)).toContain("missing-dco");
		expect(classifyPr(pr(102), [], signedSubset, mainChecks)).not.toContain("missing-dco");
	});

	it("parseSignoff splits Name <email>, and rejects a bare token", () => {
		expect(parseSignoff("Jane Doe <jane@example.com>")).toEqual({ name: "Jane Doe", email: "jane@example.com" });
		expect(parseSignoff("not a trailer")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("classifyPr integration — ordered findings over the fixtures", () => {
	it("#101 human draft, 1500 lines, no checklist, signed → template-incomplete, size-xl, draft (in order)", () => {
		expect(classifyPr(pr(101), [], signedSubset, mainChecks)).toEqual(["template-incomplete", "size-xl", "draft"]);
	});

	it("#33 Dependabot with the flaky shell leg → ci-flaky, ready-for-review (no template, no dco)", () => {
		const botCommits = commits.filter((c) => c.sha.startsWith("b0d472"));
		expect(classifyPr(pr(33), flakyChecks, botCommits, mainChecks)).toEqual(["ci-flaky", "ready-for-review"]);
	});

	it("#102 clean human PR with a checklist and green checks → only ready-for-review", () => {
		expect(classifyPr(pr(102), [], signedSubset, mainChecks)).toEqual(["ready-for-review"]);
	});

	it("the returned findings are always a subset of the closed set, in canonical order", () => {
		const findings = classifyPr(pr(101), redChecks, commits, []);
		for (const f of findings) expect(FINDING_ORDER as readonly string[]).toContain(f);
		const positions = findings.map((f) => (FINDING_ORDER as readonly Finding[]).indexOf(f));
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("issue triage: needs-triage iff no area label and not already present", () => {
	it("fires on an issue with no labels", () => {
		expect(issueLabelChange(issueList[0]!).add).toEqual(["needs-triage"]);
	});

	it("does NOT fire when an area label is present (positive control)", () => {
		expect(issueLabelChange(issueList[1]!).add).toEqual([]); // has "local"
	});

	it("is idempotent: an issue already carrying needs-triage is not re-added", () => {
		expect(issueLabelChange(issueList[2]!).add).toEqual([]); // already needs-triage
	});

	it("a non-area label (question) does not count as an area label", () => {
		expect(issueLabelChange(issueList[3]!).add).toEqual(["needs-triage"]);
	});

	it("never removes a label", () => {
		for (const issue of issueList) expect(issueLabelChange(issue).remove).toEqual([]);
	});

	it("the area set is exactly the ten path labels", () => {
		expect([...AREA_LABELS].sort()).toEqual(["app", "ci", "docs", "e2e", "local", "mcp", "sdk", "shell", "tools", "worker"]);
	});

	it("a human issue with no area label DOES get needs-triage (positive control for the bot exemption below)", () => {
		expect(isBotAuthor(issueList[0]!)).toBe(false);
		expect(issueLabelChange(issueList[0]!).add).toEqual(["needs-triage"]);
	});

	it("is SUPPRESSED for a bot-authored issue even with no area label — the same isBotAuthor predicate the PR side uses, agreeing with triage-label.yml's login.endsWith(\"[bot]\") check", () => {
		expect(isBotAuthor(issueList[4]!)).toBe(true);
		expect(issueList[4]!.labels).toEqual([]); // no area label, so the unconditional rule would fire
		expect(issueLabelChange(issueList[4]!).add).toEqual([]);
		expect(issueLabelChange(issueList[4]!).remove).toEqual([]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("comment templates are data, asserted verbatim", () => {
	it("has a body for the six actionable findings and NONE for the two status findings", () => {
		expect(Object.keys(TEMPLATES).sort()).toEqual([
			"ci-flaky",
			"ci-red",
			"missing-dco",
			"not-required-red",
			"size-xl",
			"template-incomplete",
		]);
		expect("draft" in TEMPLATES).toBe(false);
		expect("ready-for-review" in TEMPLATES).toBe(false);
	});

	it("missing-dco gives both remedies, force-with-lease, and the #sign-off-dco anchor", () => {
		const body = TEMPLATES["missing-dco"];
		expect(body).toContain("git commit --amend -s");
		expect(body).toContain("git rebase --signoff <base>");
		expect(body).toContain("git push --force-with-lease");
		expect(body).toContain("CONTRIBUTING.md#sign-off-dco");
	});

	it("not-required-red explains fork/GHCR, cites ci.yml:65-78, and ends with the mandated sentence", () => {
		const body = TEMPLATES["not-required-red"];
		expect(body).toContain("container (real image)");
		expect(body).toContain("local (typecheck + unit + smoke)");
		expect(body).toContain("private GitHub Container Registry");
		expect(body).toContain(".github/workflows/ci.yml#L65-L78");
		expect(body.endsWith("Neither is one of the fifteen required contexts, so this does not block your merge.")).toBe(true);
	});

	it("the ci.yml#L65-L78 citation is not a stale line number: those lines in the real file are the fork/GHCR paragraph", () => {
		// A deep link pins a LINE RANGE, not the text at it -- the two can drift
		// independently the moment either file is edited. This test re-derives the
		// range from `TEMPLATES["not-required-red"]` itself and reads the CURRENT
		// `.github/workflows/ci.yml` from disk, so a future edit to either file that
		// silently moves the paragraph fails HERE, which is exactly the bug this row
		// was created to fix (the link had drifted from 62-72 to 65-78).
		const body = TEMPLATES["not-required-red"];
		const m = /ci\.yml#L(\d+)-L(\d+)/.exec(body);
		expect(m).not.toBeNull();
		const [, startStr, endStr] = m!;
		const start = Number(startStr);
		const end = Number(endStr);

		const ciYmlPath = join(import.meta.dir, "..", ".github", "workflows", "ci.yml");
		const lines = readFileSync(ciYmlPath, "utf8").split(/\r?\n/);
		const cited = lines.slice(start - 1, end).join("\n"); // 1-indexed, inclusive

		expect(cited).toContain("FORK PRs CANNOT PULL THE PRIVATE PACKAGE");
		expect(cited).toContain("private `ezilhq/ezil-os-desktop`");
		// A substring check alone is too weak: the OLD (wrong) range 62-72 still
		// overlaps the tail of this paragraph (which starts at 65), so it would
		// still contain both phrases above and this test would not have caught the
		// bug it exists for. The paragraph is comment-boxed by a bare `#` line
		// immediately before its first line and immediately after its last --
		// asserting THOSE two lines pins the exact boundary, not just an overlap.
		expect((lines[start - 2] ?? "").trim()).toBe("#"); // the line just before `start`
		expect((lines[end] ?? "").trim()).toBe("#"); // the line just after `end`
	});

	it("ci-flaky says known flake, not your change, maintainer re-run", () => {
		const body = TEMPLATES["ci-flaky"];
		expect(body).toContain("known-flaky");
		expect(body).toContain("not your change");
		expect(body).toContain("re-run");
	});

	it("each CONTRIBUTING anchor a template links is one of the four this row depends on", () => {
		const anchors = ["#sign-off-dco", "#how-to-send-a-pr", "#reading-ci", "#pr-size"];
		expect(TEMPLATES["template-incomplete"]).toContain("#how-to-send-a-pr");
		expect(TEMPLATES["ci-red"]).toContain("#reading-ci");
		expect(TEMPLATES["ci-flaky"]).toContain("#reading-ci");
		expect(TEMPLATES["size-xl"]).toContain("#pr-size");
		for (const body of Object.values(TEMPLATES)) {
			const matches = body.match(/CONTRIBUTING\.md(#[a-z-]+)/g) ?? [];
			for (const m of matches) expect(anchors).toContain(m.replace("CONTRIBUTING.md", ""));
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("comment assembly and marker idempotence", () => {
	it("buildComment merges sections, each behind its marker, plus one footer; null when empty", () => {
		const body = buildComment(["missing-dco", "size-xl", "draft"]);
		expect(body).not.toBeNull();
		expect(body!).toContain(marker("missing-dco"));
		expect(body!).toContain(marker("size-xl"));
		expect(body!).not.toContain(marker("draft")); // draft is not a comment finding
		expect(body!).toContain("tools/triage.ts"); // footer
		expect(buildComment(["draft", "ready-for-review"])).toBeNull(); // status-only → nothing to say
		expect(buildComment([])).toBeNull();
	});

	it("markersIn finds the markers a prior comment left", () => {
		const prior = [`intro\n${marker("missing-dco")}\nbody`, `${marker("ci-flaky")} more`];
		expect([...markersIn(prior)].sort()).toEqual(["ci-flaky", "missing-dco"]);
	});

	it("findingsToPost drops a finding whose marker is already present — a second run posts nothing", () => {
		const findings: Finding[] = ["missing-dco", "size-xl", "ready-for-review"];
		const firstRun = findingsToPost(findings, new Set());
		expect(firstRun).toEqual(["missing-dco", "size-xl"]); // ready-for-review has no template
		expect(buildComment(firstRun)).not.toBeNull();

		const alreadyPosted = markersIn([buildComment(firstRun)!]);
		const secondRun = findingsToPost(findings, alreadyPosted);
		expect(secondRun).toEqual([]);
		expect(buildComment(secondRun)).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the action plan cannot express destruction", () => {
	const samplePrs: PrTriage[] = [
		{
			number: 1,
			title: "t",
			findings: ["missing-dco"],
			size: "size/M",
			labelsToAdd: ["size/M"],
			labelsToRemove: ["size/L"],
			redChecks: [],
			wouldPost: "hello",
		},
	];
	const sampleIssues: IssueTriage[] = [
		{ number: 2, title: "i", findings: ["needs-triage"], labelsToAdd: ["needs-triage"], labelsToRemove: [], wouldPost: null },
	];

	it("planActions emits only comment / add-label / remove-label", () => {
		const actions = planActions(samplePrs, sampleIssues);
		for (const a of actions) expect(["comment", "add-label", "remove-label"]).toContain(a.kind);
		expect(actions.map((a) => a.kind)).toEqual(["comment", "add-label", "remove-label", "add-label"]);
	});

	it("argsFor only ever calls `pr`/`issue` with `comment`/`edit` — never close/merge/ready/review/rerun", () => {
		const actions = planActions(samplePrs, sampleIssues);
		const forbidden = ["close", "merge", "ready", "review", "rerun", "delete", "--delete", "reopen"];
		for (const a of actions) {
			const args = argsFor(a, "EZiLHQ/ezil-os");
			expect(["pr", "issue"]).toContain(args[0]!);
			expect(["comment", "edit"]).toContain(args[1]!);
			for (const token of args) expect(forbidden).not.toContain(token);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the dry-run write gate", () => {
	const actions: Action[] = [
		{ kind: "comment", target: "pr", number: 1, body: "x" },
		{ kind: "add-label", target: "pr", number: 1, label: "size/M" },
	];

	it("post:false invokes gh zero times", async () => {
		const calls: string[][] = [];
		await applyActions(actions, { post: false, repo: "r", run: async (a) => void calls.push(a) });
		expect(calls.length).toBe(0);
	});

	it("post:true invokes gh exactly once per action, with the argsFor vector", async () => {
		const calls: string[][] = [];
		await applyActions(actions, { post: true, repo: "r", run: async (a) => void calls.push(a) });
		expect(calls.length).toBe(2);
		expect(calls[0]).toEqual(argsFor(actions[0]!, "r"));
		expect(calls[1]).toEqual(argsFor(actions[1]!, "r"));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("normalisers reject a broken shape rather than mis-reading it", () => {
	it("normalizePrChecks reads name+bucket", () => {
		expect(flakyChecks.find((c) => c.name === "DCO")?.bucket).toBe("pass");
		expect(flakyChecks.find((c) => c.name.startsWith("shell"))?.bucket).toBe("fail");
	});

	it("normalizePrChecks throws on an unknown bucket (positive control: a known one passes)", () => {
		expect(normalizePrChecks([{ name: "x", bucket: "pass" }])).toEqual([{ name: "x", bucket: "pass" }]);
		expect(() => normalizePrChecks([{ name: "x", bucket: "greenish" }])).toThrow(/unrecognised check bucket/);
	});

	it("normalizeMainChecks maps conclusion+status to buckets", () => {
		expect(mainChecks.every((c) => c.bucket === "pass")).toBe(true);
		expect(normalizeMainChecks({ check_runs: [{ name: "x", status: "in_progress", conclusion: null }] })[0]!.bucket).toBe(
			"pending",
		);
		expect(normalizeMainChecks({ check_runs: [{ name: "y", status: "completed", conclusion: "failure" }] })[0]!.bucket).toBe(
			"fail",
		);
	});

	it("normalizeCommits counts parents and pulls the git author ident", () => {
		expect(commits.length).toBe(7);
		expect(commits.find((c) => c.sha.startsWith("444444"))?.parents).toBe(2);
		expect(commits.find((c) => c.sha.startsWith("111111"))?.authorEmail).toBe("jane@example.com");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("the cursor is machine state, and a broken one is loud", () => {
	it("inScope: a null since is everything; otherwise it is a >= comparison", () => {
		expect(inScope("2020-01-01T00:00:00Z", null)).toBe(true);
		expect(inScope("2026-09-05T00:00:00Z", "2026-09-04T00:00:00Z")).toBe(true);
		expect(inScope("2026-09-03T00:00:00Z", "2026-09-04T00:00:00Z")).toBe(false);
	});

	it("readCursor returns null for a missing file", () => {
		expect(readCursor(join(tmpdir(), "definitely-not-here-triage-cursor.json"))).toBeNull();
	});

	it("readCursor throws on a present-but-invalid cursor rather than collapsing to a first run", () => {
		const dir = mkdtempSync(join(tmpdir(), "triage-cursor-"));
		try {
			const bad = join(dir, "c.json");
			writeFileSync(bad, "not json at all");
			expect(() => readCursor(bad)).toThrow(/present but not JSON/);
			const half = join(dir, "half.json");
			writeFileSync(half, JSON.stringify({ since: "x" }));
			expect(() => readCursor(half)).toThrow(/malformed/);
			const ok = join(dir, "ok.json");
			writeFileSync(ok, JSON.stringify({ since: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z" }));
			expect(readCursor(ok)?.since).toBe("2026-09-04T00:00:00Z");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("parseArgs", () => {
	it("defaults to the repo, no since, dry run", () => {
		expect(parseArgs([])).toEqual({ repo: "EZiLHQ/ezil-os", since: null, post: false, help: false });
	});

	it("reads --repo, --since, --post", () => {
		expect(parseArgs(["--repo", "a/b", "--since", "2026-01-01T00:00:00Z", "--post"])).toEqual({
			repo: "a/b",
			since: "2026-01-01T00:00:00Z",
			post: true,
			help: false,
		});
	});

	it("refuses an unknown flag and a value-less option", () => {
		expect(() => parseArgs(["--wat"])).toThrow(/unknown argument/);
		expect(() => parseArgs(["--repo"])).toThrow(/--repo needs/);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe("run() end to end over the fixtures, with injected fetchers", () => {
	const botCommits = commits.filter((c) => c.sha.startsWith("b0d472"));
	const checksByPr: Record<number, Check[]> = { 33: flakyChecks };

	const fetchers = {
		openPrs: async () => prList,
		prChecks: async (_repo: string, number: number) => checksByPr[number] ?? [],
		prCommits: async (_repo: string, number: number) => (number === 33 || number === 34 ? botCommits : signedSubset),
		prComments: async () => [] as string[],
		mainChecks: async () => mainChecks,
		openIssues: async () => issueList,
		requiredContexts: async () => [...REQUIRED_CONTEXTS],
	};

	it("classifies every PR, plans the labels, and reports drift-free", async () => {
		const recorded: Action[] = [];
		const { summary } = await run({ repo: "EZiLHQ/ezil-os", since: null, post: false }, fetchers, async (a) => {
			recorded.push(...a);
		});

		const p33 = summary.prs.find((p) => p.number === 33)!;
		expect(p33.findings).toEqual(["ci-flaky", "ready-for-review"]);
		expect(p33.labelsToAdd).toEqual(["size/S"]);
		expect(p33.wouldPost).not.toBeNull(); // ci-flaky has a template

		const p101 = summary.prs.find((p) => p.number === 101)!;
		expect(p101.findings).toEqual(["template-incomplete", "size-xl", "draft"]);

		const p102 = summary.prs.find((p) => p.number === 102)!;
		expect(p102.findings).toEqual(["ready-for-review"]);
		expect(p102.labelsToRemove).toEqual(["size/L"]);
		expect(p102.wouldPost).toBeNull(); // ready-for-review is a signal, not a comment

		expect(summary.requiredContextsDrift).toBeNull();
		expect(summary.issues.find((i) => i.number === 201)!.labelsToAdd).toEqual(["needs-triage"]);
		expect(summary.issues.find((i) => i.number === 205)!.labelsToAdd).toEqual([]); // bot-authored, exempt end to end
		expect(summary.counts.openPrs).toBe(5);
		expect(summary.counts.openIssues).toBe(5);
	});

	it("since filters by updatedAt", async () => {
		const { summary } = await run({ repo: "r", since: "2026-09-05T10:30:00Z", post: false }, fetchers, async () => {});
		// only #103 (11:00) is at/after 10:30 among PRs
		expect(summary.prs.map((p) => p.number)).toEqual([103]);
	});

	it("reports drift when the constant and the live ruleset disagree", async () => {
		const drifted = { ...fetchers, requiredContexts: async () => ["DCO", "a-new-required-check"] };
		const { summary } = await run({ repo: "r", since: null, post: false }, drifted, async () => {});
		expect(summary.requiredContextsDrift).not.toBeNull();
		expect(summary.requiredContextsDrift!.join("\n")).toContain("a-new-required-check");
	});
});
