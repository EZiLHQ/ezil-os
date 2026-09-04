import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { describe, expect, it } from "bun:test";

import {
	DEFAULT_IDLE_THRESHOLD_MS,
	MalformedArtifact,
	coverageReport,
	detectStalls,
	discoverWorktreeRunsDirs,
	inFlightTasks,
	latestPerTask,
	loadAllArtifacts,
	loadArtifacts,
	loadWorktreeArtifactsTolerant,
	parseArtifact,
	reconcile,
	stallCoverage,
	worktreesBaseDir,
	type ArtifactOrigin,
	type LoadedArtifact,
} from "./ledger.ts";
import { REQUIRED_COLUMNS, parseTasks } from "./waves.ts";

const HEADER = REQUIRED_COLUMNS.join(",");

function csv(...rows: readonly string[]): string {
	return `${HEADER}\n${rows.join("\n")}\n`;
}

function row(id: string, status: string, title = `title for ${id}`): string {
	// Quoted on the way in as well as on the way out. A helper that emitted a
	// bare comma would be writing a file the parser is right to reject, and the
	// test would be measuring the fixture rather than the code.
	const field = title.includes(",") ? `"${title}"` : title;
	return `${id},A,0,${field},${id}.ts,,claude,sonnet,high,none,,,,COMMITTED,${status},,`;
}

function artifactJson(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		taskId: "T1",
		runId: "wf_abc123",
		status: "done",
		doneRung: "INDEPENDENT_TEST_PASS",
		evidence: "590 pass / 0 fail",
		startedAt: "2026-08-16T10:00:00Z",
		updatedAt: "2026-08-16T10:05:00Z",
		...overrides,
	});
}

function loaded(
	taskId: string,
	status: string,
	writtenAtMs: number,
	evidence = "e",
	runId = "wf_1",
	origin: ArtifactOrigin = "main",
): LoadedArtifact {
	return {
		artifact: parseArtifact(artifactJson({ taskId, status, evidence, runId }), "test"),
		path: `test/${taskId}.json`,
		writtenAtMs,
		origin,
	};
}

describe("reading an artifact", () => {
	it("accepts a well-formed one, so the refusals below are not a parser that refuses everything", () => {
		const artifact = parseArtifact(artifactJson(), "x.json");

		expect(artifact.taskId).toBe("T1");
		expect(artifact.status).toBe("done");
		expect(artifact.notes).toBeUndefined();
	});

	it("keeps notes when present", () => {
		expect(parseArtifact(artifactJson({ notes: "flaky on first run" }), "x.json").notes).toBe("flaky on first run");
	});

	it("refuses a status outside the vocabulary", () => {
		expect(() => parseArtifact(artifactJson({ status: "probably-fine" }), "x.json")).toThrow(MalformedArtifact);
	});

	it("refuses an empty evidence string, because 'it worked' with no observation is the failure this project keeps having", () => {
		expect(() => parseArtifact(artifactJson({ evidence: "" }), "x.json")).toThrow(/non-empty string evidence/);
	});

	it("refuses a missing field rather than defaulting it", () => {
		const withoutRunId = JSON.parse(artifactJson()) as Record<string, unknown>;
		delete withoutRunId["runId"];

		expect(() => parseArtifact(JSON.stringify(withoutRunId), "x.json")).toThrow(/non-empty string runId/);
	});

	it("refuses text that is not JSON", () => {
		expect(() => parseArtifact("STATUS: done", "x.json")).toThrow(/is not JSON/);
	});
});

describe("the newest artifact per task wins", () => {
	it("prefers the later write when a task was re-dispatched under a new run id", () => {
		const latest = latestPerTask([loaded("T1", "failed", 1_000, "first attempt", "wf_1"), loaded("T1", "done", 2_000, "second attempt", "wf_2")]);

		expect(latest.get("T1")?.artifact.evidence).toBe("second attempt");
		expect(latest.get("T1")?.artifact.runId).toBe("wf_2");
	});

	it("is not merely taking the last element of the array", () => {
		// Same two artifacts, reversed. A reducer that ignored mtime would pass
		// the test above and fail this one.
		const latest = latestPerTask([loaded("T1", "done", 2_000, "second attempt", "wf_2"), loaded("T1", "failed", 1_000, "first attempt", "wf_1")]);

		expect(latest.get("T1")?.artifact.evidence).toBe("second attempt");
	});

	it("a fresher worktree artifact wins over an older main one -- the row stays in flight pre-merge", () => {
		const latest = latestPerTask([
			loaded("T1", "done", 1_000, "main copy", "wf_m", "main"),
			loaded("T1", "running", 2_000, "worktree copy", "wf_w", "worktree:T1"),
		]);

		expect(latest.get("T1")?.origin).toBe("worktree:T1");
		expect(latest.get("T1")?.artifact.evidence).toBe("worktree copy");
	});

	it("flips to the main copy the moment it is the newer write -- what a merge looks like from here", () => {
		// Same two artifacts as above, mtimes flipped. Precedence is decided
		// by mtime alone, not by origin -- see the doc comment on
		// latestPerTask. Nothing about "worktree" or "main" is special-cased
		// in the comparison itself.
		const latest = latestPerTask([
			loaded("T1", "running", 2_000, "worktree copy", "wf_w", "worktree:T1"),
			loaded("T1", "done", 3_000, "main copy", "wf_m", "main"),
		]);

		expect(latest.get("T1")?.origin).toBe("main");
		expect(latest.get("T1")?.artifact.status).toBe("done");
	});
});

describe("folding the ledger into the CSV", () => {
	it("writes status, run id and evidence onto the matching row", () => {
		const out = reconcile(csv(row("T1", "running")), latestPerTask([loaded("T1", "done", 1_000, "590 pass / 0 fail", "wf_x")]));
		const task = parseTasks(out).find((t) => t.id === "T1");

		expect(task?.status).toBe("done");
		expect(task?.runId).toBe("wf_x");
		expect(task?.evidence).toBe("590 pass / 0 fail");
	});

	it("never folds into a pending row: nothing was dispatched, so no artifact can be its own", () => {
		// Round OH: rows W3 and W5 were added pending and an older round's
		// artifacts with the same ids folded them `done`, run id and all.
		const out = reconcile(csv(row("W3", "pending")), latestPerTask([loaded("W3", "done", 1_000, "2134 pass / 7 fail", "studio6")]));
		const task = parseTasks(out).find((t) => t.id === "W3");

		expect(task?.status).toBe("pending");
		expect(task?.runId).toBe("");
		expect(task?.evidence).toBe("");
	});

	it("folds only an artifact of the row's own run once the row names one", () => {
		const running = row("T1", "running").replace(/,COMMITTED,running,,$/, ",COMMITTED,running,wf_a,");
		const foreign = reconcile(csv(running), latestPerTask([loaded("T1", "done", 1_000, "8 pass", "wf_b")]));
		expect(parseTasks(foreign).find((t) => t.id === "T1")?.status).toBe("running");
		expect(parseTasks(foreign).find((t) => t.id === "T1")?.runId).toBe("wf_a");

		// Positive control: the same artifact from the row's own run folds.
		const own = reconcile(csv(running), latestPerTask([loaded("T1", "done", 1_000, "8 pass", "wf_a")]));
		expect(parseTasks(own).find((t) => t.id === "T1")?.status).toBe("done");
	});

	it("leaves a row with no artifact exactly as it was", () => {
		const before = csv(row("T1", "running"), row("T2", "pending"));
		const after = reconcile(before, latestPerTask([loaded("T1", "done", 1_000)]));

		expect(parseTasks(after).find((t) => t.id === "T2")?.status).toBe("pending");
	});

	it("does NOT let an artifact enlarge its own file ownership or drop a dependency", () => {
		// The whole point of reconcile() touching three columns and no others.
		// An agent that could rewrite owns_files could quietly take a file
		// another agent in its wave holds, and the overlap check would then
		// pass against the plan it had just edited.
		const before = csv(row("T1", "running"));
		const after = reconcile(before, latestPerTask([loaded("T1", "done", 1_000)]));

		const [b] = parseTasks(before);
		const [a] = parseTasks(after);
		expect(a?.ownsFiles).toEqual(b?.ownsFiles ?? []);
		expect(a?.title).toBe(b?.title ?? "");
		expect(a?.model).toBe(b?.model ?? "");
	});

	it("re-quotes a field containing a comma so the file it writes is the file it can read", () => {
		const out = reconcile(csv(row("T1", "running", "port ui, shell, and data")), latestPerTask([loaded("T1", "done", 1_000, "8 pass, 0 fail")]));

		expect(parseTasks(out).find((t) => t.id === "T1")?.title).toBe("port ui, shell, and data");
		expect(parseTasks(out).find((t) => t.id === "T1")?.evidence).toBe("8 pass, 0 fail");
	});

	it("folds a worktree artifact's terminal status into the row, before merge -- the worker's own claim, not yet verified", () => {
		// Requirement 4: a worktree's `done` DOES fold pre-merge. The supervisor's
		// merge check is the second gate, not this one.
		const out = reconcile(csv(row("T1", "running")), latestPerTask([loaded("T1", "done", 1_000, "590 pass / 0 fail", "wf_w", "worktree:T1")]));

		expect(parseTasks(out).find((t) => t.id === "T1")?.status).toBe("done");
	});

	it("does NOT fold a running status into the CSV -- main or worktree, the row stays as the plan left it", () => {
		// Starting from `pending` (not `running`) so a fold would be visible:
		// if `reconcile` folded `running` verbatim the way it used to, this row
		// would come out `running` instead of staying `pending`.
		const before = csv(row("T1", "pending"));
		const after = reconcile(before, latestPerTask([loaded("T1", "running", 1_000, "still going", "wf_w", "worktree:T1")]));

		expect(parseTasks(after).find((t) => t.id === "T1")?.status).toBe("pending");
	});
});

describe("stall detection", () => {
	const now = 10_000_000;

	it("reports a running row whose artifact has gone quiet past the threshold, and names it", () => {
		// The positive control the rest of this block is measured against: a row
		// and an artifact that genuinely should stall, and the detector saying
		// which task. `toHaveLength(1)` alone would pass for a detector that
		// named the wrong row.
		const tasks = parseTasks(csv(row("T1", "running"), row("T2", "done")));
		const stalls = detectStalls(tasks, latestPerTask([loaded("T1", "running", now - DEFAULT_IDLE_THRESHOLD_MS - 1), loaded("T2", "done", now - 99_999_999)]), now, DEFAULT_IDLE_THRESHOLD_MS);

		expect(stalls.map((stall) => stall.task.id)).toEqual(["T1"]);
		expect(stalls[0]?.reason).toContain("changed hypothesis");
	});

	it("reports a task whose ARTIFACT says running even though the row does not", () => {
		// The dispatch shape 118ae6dc actually used: `pending` rows, `running`
		// artifacts. The row is a projection of the ledger, so when the two
		// disagree about whether work is in flight the ledger is the fresher of
		// the two and a stall there is still a stall.
		const stalls = detectStalls(
			parseTasks(csv(row("T1", "pending"))),
			latestPerTask([loaded("T1", "running", now - DEFAULT_IDLE_THRESHOLD_MS - 1)]),
			now,
			DEFAULT_IDLE_THRESHOLD_MS,
		);

		expect(stalls.map((stall) => stall.task.id)).toEqual(["T1"]);
		expect(stalls[0]?.reason).toContain("row does not say running but its artifact does");
	});

	it("does NOT report a pending row whose running artifact was written recently", () => {
		// The control on the branch above. Without it, a rule that flagged every
		// pending row carrying any artifact would pass that test.
		expect(detectStalls(parseTasks(csv(row("T1", "pending"))), latestPerTask([loaded("T1", "running", now - 1_000)]), now, DEFAULT_IDLE_THRESHOLD_MS)).toEqual([]);
	});

	it("does NOT treat a pending row with no artifact as a dead dispatch", () => {
		// 58 rows in the real plan are exactly this. Extending the absence
		// signal to `pending` would name the entire backlog, and a detector that
		// cries wolf ends up ignored -- the same place as one that never fires.
		expect(detectStalls(parseTasks(csv(row("T1", "pending"), row("T2", "pending"))), new Map(), now, DEFAULT_IDLE_THRESHOLD_MS)).toEqual([]);
	});

	it("does NOT report a running row whose artifact already reported a terminal status", () => {
		// The work landed and nobody folded the row back yet. `reconcile` fixes
		// that; the stall net is not the place to shout about it.
		expect(detectStalls(parseTasks(csv(row("T1", "running"))), latestPerTask([loaded("T1", "done", now - 99_999_999)]), now, DEFAULT_IDLE_THRESHOLD_MS)).toEqual([]);
	});

	it("reports a running row with NO artifact at all — a workflow that died with the session", () => {
		const stalls = detectStalls(parseTasks(csv(row("T1", "running"))), new Map(), now, DEFAULT_IDLE_THRESHOLD_MS);

		expect(stalls[0]?.reason).toContain("died with the session");
		expect(stalls[0]?.idleMs).toBe(Number.POSITIVE_INFINITY);
	});

	it("does NOT report a running row that wrote recently", () => {
		// The positive control. Without it, a detector that flags every running
		// task passes both tests above.
		const stalls = detectStalls(parseTasks(csv(row("T1", "running"))), latestPerTask([loaded("T1", "running", now - 1_000)]), now, DEFAULT_IDLE_THRESHOLD_MS);

		expect(stalls).toEqual([]);
	});

	it("does NOT report a task that finished long ago", () => {
		const stalls = detectStalls(parseTasks(csv(row("T1", "done"))), latestPerTask([loaded("T1", "done", now - 99_999_999)]), now, DEFAULT_IDLE_THRESHOLD_MS);

		expect(stalls).toEqual([]);
	});

	it("does NOT report a pending task that has never started", () => {
		expect(detectStalls(parseTasks(csv(row("T1", "pending"))), new Map(), now, DEFAULT_IDLE_THRESHOLD_MS)).toEqual([]);
	});

	it("judges staleness on the file's mtime, not on the timestamp the agent writes", () => {
		// A hung agent stops updating `updatedAt` too, so trusting it would
		// mean a stalled worker looks healthy for as long as it is stalled.
		const stale = loaded("T1", "running", now - DEFAULT_IDLE_THRESHOLD_MS - 1);
		const withFreshSelfReport: LoadedArtifact = {
			...stale,
			artifact: { ...stale.artifact, updatedAt: new Date(now).toISOString() },
		};

		expect(detectStalls(parseTasks(csv(row("T1", "running"))), latestPerTask([withFreshSelfReport]), now, DEFAULT_IDLE_THRESHOLD_MS)).toHaveLength(1);
	});
});

describe("the stall check cannot go quietly dead", () => {
	// The guard this file was missing, and the one that matters most here.
	//
	// Every test above builds a fixture with a `running` row in it, so the
	// detector was proved to work on input the real repository has not produced
	// since 2026-08-19. `detectStalls` returning `[]` means "nothing stalled" in
	// those tests and "nothing could have stalled" in production, and the two
	// are the same empty array. Ten days of rounds read as green on a net that
	// was structurally incapable of firing.
	//
	// So what is pinned below is not the stall verdict. It is that the tool
	// always says which of those two it just observed.
	const now = 10_000_000;

	it("counts exactly the rows detectStalls walks, so the report cannot drift from the rule", () => {
		// If someone narrows the in-flight condition, this count narrows with it
		// and the NOT ACTIVE warning appears. A second copy of the condition
		// written for the reporting would keep claiming coverage the rule no
		// longer has, which is the original failure with extra steps.
		const tasks = parseTasks(csv(row("T1", "running"), row("T2", "pending"), row("T3", "done"), row("T4", "pending")));
		const latest = latestPerTask([loaded("T2", "running", now - 1_000), loaded("T3", "done", now - 1_000)]);

		expect(stallCoverage(tasks, latest).inFlight).toEqual(inFlightTasks(tasks, latest).map(({ task }) => task.id));
		expect(stallCoverage(tasks, latest).inFlight).toEqual(["T1", "T2"]);
		expect(stallCoverage(tasks, latest).byRow).toBe(1);
		expect(stallCoverage(tasks, latest).byArtifact).toBe(1);
	});

	it("says NOT ACTIVE when nothing in the plan or the ledger can match the rule", () => {
		const tasks = parseTasks(csv(row("T1", "pending"), row("T2", "done")));
		const coverage = stallCoverage(tasks, latestPerTask([loaded("T2", "done", now - 1_000)]));

		expect(coverage.inFlight).toEqual([]);
		expect(detectStalls(tasks, latestPerTask([loaded("T2", "done", now - 1_000)]), now, DEFAULT_IDLE_THRESHOLD_MS)).toEqual([]);

		const report = coverageReport(coverage).join("\n");
		expect(report).toContain("STALL CHECK NOT ACTIVE");
		expect(report).toContain("2 row(s) inspected, 0 in flight");
		expect(report).toContain("died with the session");
	});

	it("does NOT say NOT ACTIVE when a row is genuinely in flight", () => {
		// The positive control on the warning. Without it, a report that printed
		// the death notice unconditionally would pass the test above, and the
		// warning would mean nothing the first time it appeared for real.
		const report = coverageReport(stallCoverage(parseTasks(csv(row("T1", "running"))), new Map())).join("\n");

		expect(report).not.toContain("NOT ACTIVE");
		expect(report).toContain("stall check: 1 row(s) inspected, 1 in flight");
	});

	it("names row statuses outside the vocabulary, because the rule matches `running` exactly", () => {
		// `blocked-on-o9` and friends are already in the real file. A row typed
		// `in-progress` would be skipped in the same silence, and this line is
		// the only place it would show.
		const report = coverageReport(stallCoverage(parseTasks(csv(row("T1", "in-progress"), row("T2", "pending"))), new Map())).join("\n");

		expect(report).toContain("outside the vocabulary");
		expect(report).toContain("in-progress x1");
	});

	it("stays quiet about the vocabulary when every status is a known one", () => {
		// The control on the note above.
		expect(coverageReport(stallCoverage(parseTasks(csv(row("T1", "pending"), row("T2", "done"))), new Map())).join("\n")).not.toContain("outside the vocabulary");
	});

	it("splits the artifact count by origin in the summary line, so a worktree-only round is visible", () => {
		const tasks = parseTasks(csv(row("T1", "running")));
		const latest = latestPerTask([
			loaded("T1", "running", now - 1_000, "e", "wf_1", "worktree:T1"),
			loaded("T2", "done", now - 1_000, "e", "wf_2", "main"),
		]);
		const coverage = stallCoverage(tasks, latest);

		// M + W == artifactsSeen, per the doc comment on StallCoverage.
		expect(coverage.artifactsFromMain).toBe(1);
		expect(coverage.artifactsFromWorktree).toBe(1);
		expect(coverage.artifactsFromMain + coverage.artifactsFromWorktree).toBe(coverage.artifactsSeen);
		expect(coverageReport(coverage).join("\n")).toContain(
			"stall check: 1 row(s) inspected, 1 in flight (1 by row, 0 by artifact — 1 from main, 1 from worktrees)",
		);
	});

	describe("against the real plan and the real ledger", () => {
		const ROOT = `${import.meta.dir}/..`;
		const realTasks = parseTasks(readFileSync(`${ROOT}/docs/TASKS.csv`, "utf8"));
		const realLatest = latestPerTask(loadArtifacts(`${ROOT}/artifacts/runs`));

		it("is reading the real corpus and not an empty one", () => {
			// Without this the two assertions below are vacuously true the moment
			// the read breaks -- which is the same class of failure they exist to
			// catch.
			//
			// `50` (EZiL-Works' own plan size at the time this test was written)
			// replaced with `20`: EZiL-OS's round ANYWHERE seeded 24 rows, matching
			// the threshold `waves.test.ts`'s own "reads the real docs/TASKS.csv"
			// test already uses for the same file.
			expect(realTasks.length).toBeGreaterThan(20);
			expect(realLatest.size).toBeGreaterThan(0);
		});

		it("always states what the stall check could see, whatever that turns out to be", () => {
			// The durable invariant: silence is not a permitted output. Whether
			// the net is live or dead, `bun tools/ledger.ts` says which.
			const report = coverageReport(stallCoverage(realTasks, realLatest)).join("\n");

			expect(report).toMatch(/^(stall check: |STALL CHECK NOT ACTIVE)/);
			expect(report).toContain(`${realTasks.length} row(s) inspected`);
		});

		it("records that the net is NOT currently active in this worktree's own view", () => {
			// EZiL-Works' version of this test pinned the OPPOSITE fact
			// (`inFlight.length > 0`) once that repo's wave dispatched WITH
			// `running` rows in docs/TASKS.csv -- see the historical note that
			// test's own comment carried, which is itself evidence this
			// assertion is expected to track live reality rather than stay
			// fixed forever. EZiL-OS's reality differs on two counts, not just
			// one path: (1) round ANYWHERE's wave-0 dispatch left every row
			// `pending` in docs/TASKS.csv (this port's own O2 row included --
			// not this task's file to change), and (2) `loadArtifacts` here
			// reads only THIS worktree's own `artifacts/runs`, never a sibling
			// worktree's `running` artifact (that cross-worktree read is
			// `loadAllArtifacts`, exercised by the synthetic fixtures above,
			// not this real-corpus block). By the state this file is committed
			// in -- this task's own run artifact folded to `done` -- nothing in
			// this worktree's local view is running, so the honest pin is NOT
			// ACTIVE. A red here is the same kind of good news the original
			// comment described: it means a dispatch protocol now writes a
			// `running` marker this worktree can see.
			const coverage = stallCoverage(realTasks, realLatest);

			expect(coverageReport(coverage).join("\n")).toContain("STALL CHECK NOT ACTIVE");
		});

		it("would fire on the real plan the moment one row is marked running", () => {
			// The positive control on the pin above. It proves the rule still
			// works against the real rows and not just an empty plan.
			//
			// Isolated against every OTHER row this wave might currently have
			// `running` -- by ROW or by its own ARTIFACT -- before the one under
			// test (index 0) is turned on. The row half matters because other
			// live agents in this wave might be dispatched right now; the
			// artifact half matters because THIS task's own artifact is exactly
			// as real, and as this session runs long past its last write to
			// artifacts/runs/wf-oh-2026-09-02/T1.json, that artifact goes idle
			// past the threshold like any other and starts contributing a
			// second, real stall of its own. Losing either half of the isolation
			// would make this exact-equality assertion depend on wall-clock time
			// or on what other live agents are doing, and loosening it to
			// `toContain` to cope is exactly how a detector goes quiet without
			// anyone noticing -- the failure mode this whole describe block
			// exists to catch.
			const targetId = realTasks[0]?.id ?? "";
			const dispatched = realTasks.map((task, index) =>
				index === 0 ? { ...task, status: "running" } : { ...task, status: task.status === "running" ? "pending" : task.status },
			);
			const withoutItsArtifact = new Map([...realLatest].filter(([taskId, found]) => taskId !== targetId && found.artifact.status !== "running"));

			const stalls = detectStalls(dispatched, withoutItsArtifact, Date.now(), DEFAULT_IDLE_THRESHOLD_MS);

			expect(stalls.map((stall) => stall.task.id)).toEqual([targetId]);
			expect(stalls[0]?.reason).toContain("died with the session");
			expect(coverageReport(stallCoverage(dispatched, withoutItsArtifact)).join("\n")).not.toContain("NOT ACTIVE");
		});
	});
});

describe("reading a real directory of artifacts", () => {
	it("walks run directories, and returns nothing rather than throwing when there are none", () => {
		const root = mkdtempSync(`${tmpdir()}/ezil-ledger-`);
		expect(loadArtifacts(`${root}/does-not-exist`)).toEqual([]);

		mkdirSync(`${root}/wf_one`, { recursive: true });
		mkdirSync(`${root}/wf_two`, { recursive: true });
		writeFileSync(`${root}/wf_one/T1.json`, artifactJson({ taskId: "T1", runId: "wf_one", status: "failed" }));
		writeFileSync(`${root}/wf_two/T1.json`, artifactJson({ taskId: "T1", runId: "wf_two", status: "done" }));
		writeFileSync(`${root}/wf_one/notes.txt`, "ignored");

		utimesSync(`${root}/wf_one/T1.json`, new Date(1_000), new Date(1_000));
		utimesSync(`${root}/wf_two/T1.json`, new Date(2_000), new Date(2_000));

		const artifacts = loadArtifacts(root);
		expect(artifacts).toHaveLength(2);
		expect(latestPerTask(artifacts).get("T1")?.artifact.runId).toBe("wf_two");
	});
});

describe("walking sibling worktrees", () => {
	it("derives BASE_DIR as <repo>/.claude/worktrees -- EZiL-OS keeps worktrees inside the repo, not as a sibling", () => {
		// EZiL-Works' version of this test pinned the sibling-directory form
		// (`dirname(REPO)/basename(REPO).worktrees`); EZiL-OS's `.gitignore`
		// keeps worktrees at `.claude/worktrees` instead -- see the doc comment
		// on `worktreesBaseDir` in ledger.ts.
		expect(worktreesBaseDir("/data/openclaw/projects/ezil/EZiL-OS")).toBe("/data/openclaw/projects/ezil/EZiL-OS/.claude/worktrees");
		// A trailing slash must not change the derivation -- resolve() strips it
		// before join() sees it, the same way a shell `cd && pwd` would.
		expect(worktreesBaseDir("/a/b/repo/")).toBe("/a/b/repo/.claude/worktrees");
	});

	it("never descends into a sibling literally named node_modules or .git", () => {
		const parent = mkdtempSync(`${tmpdir()}/ezil-ledger-guard-`);
		const repo = `${parent}/repo`;
		mkdirSync(repo, { recursive: true });
		const baseDir = `${repo}/.claude/worktrees`;

		mkdirSync(`${baseDir}/node_modules/artifacts/runs/wf_x`, { recursive: true });
		writeFileSync(`${baseDir}/node_modules/artifacts/runs/wf_x/X.json`, artifactJson({ taskId: "X", runId: "wf_x" }));
		mkdirSync(`${baseDir}/.git/artifacts/runs/wf_y`, { recursive: true });
		writeFileSync(`${baseDir}/.git/artifacts/runs/wf_y/Y.json`, artifactJson({ taskId: "Y", runId: "wf_y" }));
		mkdirSync(`${baseDir}/T9/artifacts/runs/wf_z`, { recursive: true });
		writeFileSync(`${baseDir}/T9/artifacts/runs/wf_z/Z.json`, artifactJson({ taskId: "Z", runId: "wf_z" }));

		expect(discoverWorktreeRunsDirs(repo).map((d) => d.taskDir)).toEqual(["T9"]);
	});

	it("loadWorktreeArtifactsTolerant returns nothing rather than throwing when the directory doesn't exist", () => {
		expect(loadWorktreeArtifactsTolerant("/does/not/exist/artifacts/runs", "worktree:X")).toEqual({ loaded: [], skipped: [] });
	});

	it("does not let one malformed artifact in a worktree blind the walk to a healthy one in the same worktree", () => {
		// Five malformed files once took `bun tools/ledger.ts` down before it
		// folded a single round of THIS repo's own artifacts/runs -- see "every
		// artifact actually on disk parses" below. A sibling worktree belongs to
		// another live agent writing with a non-atomic `cat > file`, so the same
		// strictness there would make this tool LESS trustworthy than before the
		// walk existed, not more.
		const parent = mkdtempSync(`${tmpdir()}/ezil-ledger-tolerant-`);
		const repo = `${parent}/repo`;
		mkdirSync(`${repo}/artifacts/runs`, { recursive: true });

		const baseDir = `${repo}/.claude/worktrees`;
		mkdirSync(`${baseDir}/W1/artifacts/runs/wf_1`, { recursive: true });
		writeFileSync(`${baseDir}/W1/artifacts/runs/wf_1/GOOD.json`, artifactJson({ taskId: "GOOD", runId: "wf_1", status: "running" }));

		const blank = JSON.parse(artifactJson({ taskId: "BAD" })) as Record<string, unknown>;
		delete blank["evidence"];
		writeFileSync(`${baseDir}/W1/artifacts/runs/wf_1/BAD.json`, JSON.stringify(blank));

		let result: ReturnType<typeof loadAllArtifacts> | undefined;
		expect(() => {
			result = loadAllArtifacts(repo);
		}).not.toThrow();

		expect(result?.loaded.map((a) => a.artifact.taskId)).toContain("GOOD");
		expect(result?.skipped).toHaveLength(1);
		expect(result?.skipped[0]?.path).toContain("BAD.json");
		expect(result?.skipped[0]?.error).toContain("evidence");
	});

	it("a running row is in flight and not stalled when its ONLY artifact is a fresh one in a sibling worktree", () => {
		// The house-standard fixture: a fake repo dir with docs/TASKS.csv (3
		// rows) plus <fake>/.claude/worktrees/<task>/artifacts/runs/
		// <run>/<task>.json. Row A: running, fresh worktree artifact, no main
		// copy. Row B: running, stale (20 min) worktree artifact. Row C:
		// running, no artifact anywhere.
		const parent = mkdtempSync(`${tmpdir()}/ezil-ledger-walk-`);
		const repo = `${parent}/repo`;
		mkdirSync(`${repo}/docs`, { recursive: true });
		mkdirSync(`${repo}/artifacts/runs`, { recursive: true }); // main runs dir, deliberately empty

		const tasksCsv = csv(row("A", "running"), row("B", "running"), row("C", "running"));
		writeFileSync(`${repo}/docs/TASKS.csv`, tasksCsv);

		const baseDir = `${repo}/.claude/worktrees`;

		mkdirSync(`${baseDir}/A/artifacts/runs/wf_a`, { recursive: true });
		const aPath = `${baseDir}/A/artifacts/runs/wf_a/A.json`;
		writeFileSync(aPath, artifactJson({ taskId: "A", runId: "wf_a", status: "running" }));
		// mtime left at "now" (just written) -- fresh.

		mkdirSync(`${baseDir}/B/artifacts/runs/wf_b`, { recursive: true });
		const bPath = `${baseDir}/B/artifacts/runs/wf_b/B.json`;
		writeFileSync(bPath, artifactJson({ taskId: "B", runId: "wf_b", status: "running" }));
		const stale = new Date(Date.now() - 20 * 60 * 1000);
		utimesSync(bPath, stale, stale);

		// Row C: intentionally nothing written anywhere.

		const now = Date.now();
		const tasks = parseTasks(tasksCsv);
		const latest = latestPerTask(loadAllArtifacts(repo).loaded);

		expect(latest.get("A")?.origin).toBe("worktree:A");

		const stalls = detectStalls(tasks, latest, now, DEFAULT_IDLE_THRESHOLD_MS);

		expect(stalls.map((s) => s.task.id)).not.toContain("A");

		const bStall = stalls.find((s) => s.task.id === "B");
		expect(bStall?.reason).toContain("no artifact write for");
		expect(bStall?.reason).toContain("changed hypothesis");

		const cStall = stalls.find((s) => s.task.id === "C");
		expect(cStall?.reason).toContain("died with the session");

		// Positive control for the walk itself: without the worktree copy, A
		// has nothing backing it anywhere and goes stalled the same way C does.
		rmSync(aPath);
		const latestWithoutA = latestPerTask(loadAllArtifacts(repo).loaded);
		const stallsWithoutA = detectStalls(tasks, latestWithoutA, now, DEFAULT_IDLE_THRESHOLD_MS);

		expect(stallsWithoutA.map((s) => s.task.id)).toContain("A");
		expect(stallsWithoutA.find((s) => s.task.id === "A")?.reason).toContain("died with the session");
	});

	it("does not let a worktree's checkout copy of an already-merged artifact outrank main, just because the checkout is newer", () => {
		// artifacts/runs is git-committed, so `git worktree add` gives every
		// worktree an identical copy of every already-merged run artifact,
		// stamped with the checkout's mtime -- which, being "just now", easily
		// beats main's real write time for old, already-terminal work. Measured
		// directly against the live worktrees this ran against while it was
		// built: two different worktrees' copies of the same historical
		// artifact were byte-identical, 681 seconds apart in mtime, neither of
		// which was when that file was actually written. Precedence by mtime
		// alone would let that pure copy "win" over main's own copy for a
		// reason connected to nothing anyone did.
		const parent = mkdtempSync(`${tmpdir()}/ezil-ledger-checkout-`);
		const repo = `${parent}/repo`;
		mkdirSync(`${repo}/artifacts/runs/wf_old`, { recursive: true });
		const mainPath = `${repo}/artifacts/runs/wf_old/K1.json`;
		writeFileSync(mainPath, artifactJson({ taskId: "K1", runId: "wf_old", status: "done", evidence: "12 pass / 0 fail" }));
		const old = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(mainPath, old, old);

		const baseDir = `${repo}/.claude/worktrees`;
		mkdirSync(`${baseDir}/W1/artifacts/runs/wf_old`, { recursive: true });
		// Byte-identical content, but "checked out" just now -- a fresher
		// mtime than main's, carrying no new information.
		writeFileSync(`${baseDir}/W1/artifacts/runs/wf_old/K1.json`, artifactJson({ taskId: "K1", runId: "wf_old", status: "done", evidence: "12 pass / 0 fail" }));

		const result = loadAllArtifacts(repo);
		const latest = latestPerTask(result.loaded);

		expect(latest.get("K1")?.origin).toBe("main");
		expect(result.duplicatesSkipped).toBe(1);
	});

	it("still lets a worktree win when its copy of the same run id genuinely differs from main's", () => {
		// The control on the test above: dedup must not swallow real content
		// just because the run id matches. A worker updating its OWN artifact
		// in its OWN worktree, under a run id main also happens to have an
		// (older, different) copy of, must still win on mtime.
		const parent = mkdtempSync(`${tmpdir()}/ezil-ledger-checkout-diff-`);
		const repo = `${parent}/repo`;
		mkdirSync(`${repo}/artifacts/runs/wf_old`, { recursive: true });
		const mainPath = `${repo}/artifacts/runs/wf_old/K1.json`;
		writeFileSync(mainPath, artifactJson({ taskId: "K1", runId: "wf_old", status: "running", evidence: "still going" }));
		const old = new Date(Date.now() - 60 * 60 * 1000);
		utimesSync(mainPath, old, old);

		const baseDir = `${repo}/.claude/worktrees`;
		mkdirSync(`${baseDir}/W1/artifacts/runs/wf_old`, { recursive: true });
		writeFileSync(`${baseDir}/W1/artifacts/runs/wf_old/K1.json`, artifactJson({ taskId: "K1", runId: "wf_old", status: "done", evidence: "590 pass / 0 fail" }));

		const result = loadAllArtifacts(repo);
		const latest = latestPerTask(result.loaded);

		expect(latest.get("K1")?.origin).toBe("worktree:W1");
		expect(latest.get("K1")?.artifact.status).toBe("done");
		expect(result.duplicatesSkipped).toBe(0);
	});
});

describe("every artifact actually on disk parses", () => {
	// The guard this file was missing. Five artifacts predating 2026-08-25 sat in
	// `artifacts/runs/` malformed for months -- one on the older `task` key, four
	// with no `evidence` -- and because `loadArtifacts` throws on the first bad
	// file, `bun tools/ledger.ts` exited 1 before it reached a single round. The
	// most recent round had to be folded by hand. Nothing in this suite noticed,
	// because every test above builds its own fixture: the parser was thoroughly
	// tested and the corpus it parses was never looked at.
	const REAL_RUNS = `${import.meta.dir}/../artifacts/runs`;

	/** The `.json` files under `<runsDir>/<run>/`, enumerated independently of `loadArtifacts`. */
	function jsonFilesUnder(runsDir: string): readonly string[] {
		const found: string[] = [];
		for (const runId of readdirSync(runsDir)) {
			const dir = `${runsDir}/${runId}`;
			if (!statSync(dir).isDirectory()) continue;
			for (const file of readdirSync(dir)) if (file.endsWith(".json")) found.push(`${dir}/${file}`);
		}
		return found;
	}

	it("parses every one of them, and names all the offenders rather than only the first", () => {
		const paths = jsonFilesUnder(REAL_RUNS);

		// Collected, not thrown on first sight. `loadArtifacts` stops at the
		// earliest failure, which is how a five-file problem read as a one-file
		// problem for as long as it did.
		const malformed = paths.flatMap((path) => {
			try {
				parseArtifact(readFileSync(path, "utf8"), path);
				return [];
			} catch (cause) {
				return [`${path.slice(REAL_RUNS.length + 1)}: ${cause instanceof Error ? cause.message : String(cause)}`];
			}
		});

		expect(malformed).toEqual([]);
	});

	it("is reading a real corpus, not passing because the walk found nothing", () => {
		// Without this, the assertion above is vacuously true the moment the walk
		// breaks -- which is the same class of failure it exists to catch.
		const paths = jsonFilesUnder(REAL_RUNS);

		expect(paths.length).toBeGreaterThan(0);
		// And the production path sees the same files. A divergence here means
		// `loadArtifacts` is skipping a directory the check above still covers,
		// so the ledger would be blind to artifacts this test calls clean.
		expect(loadArtifacts(REAL_RUNS)).toHaveLength(paths.length);
	});

	it("FIRES on a deliberately malformed artifact, so a green run means 'all valid' and not 'no check ran'", () => {
		// The positive control. Two files in one run directory: one valid, one
		// missing `evidence` exactly the way kyc/K1.json was.
		const root = mkdtempSync(`${tmpdir()}/ezil-ledger-corpus-`);
		mkdirSync(`${root}/wf_one`, { recursive: true });
		writeFileSync(`${root}/wf_one/T1.json`, artifactJson({ taskId: "T1" }));

		const blank = JSON.parse(artifactJson({ taskId: "T2" })) as Record<string, unknown>;
		delete blank["evidence"];
		writeFileSync(`${root}/wf_one/T2.json`, JSON.stringify(blank));

		const malformed = jsonFilesUnder(root).filter((path) => {
			try {
				parseArtifact(readFileSync(path, "utf8"), path);
				return false;
			} catch {
				return true;
			}
		});

		expect(malformed).toEqual([`${root}/wf_one/T2.json`]);
		expect(() => loadArtifacts(root)).toThrow(MalformedArtifact);
	});

	it("FIRES when the walk finds nothing, so the non-vacuity check can fail too", () => {
		// The positive control on the control: `toBeGreaterThan(0)` is only worth
		// writing if an empty tree actually produces 0 here.
		const root = mkdtempSync(`${tmpdir()}/ezil-ledger-empty-`);
		mkdirSync(`${root}/wf_empty`, { recursive: true });

		expect(jsonFilesUnder(root)).toHaveLength(0);
	});
});
