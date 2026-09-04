/**
 * The run ledger: how a task reports what happened to it, and how that reaches
 * `docs/TASKS.csv` without two agents ever writing the same file.
 *
 * ## Why agents do not write the CSV
 *
 * The obvious design is for each agent to update its own row. It does not work,
 * for the same reason the schema this repository is building is append-only:
 * concurrent writers to one file lose writes, and the loss is silent. Six
 * agents finishing within a second of each other produce one surviving row and
 * five that read as never having run.
 *
 * So each agent writes exactly one file it alone owns --
 * `artifacts/runs/<run_id>/<task_id>.json` -- and `reconcile()` folds those into
 * the CSV afterwards. The CSV becomes a projection of the ledger rather than a
 * shared mutable object, which is the same shape as `briefAsJson()`
 * re-projecting rather than serialising.
 *
 * ## Why a late failure must not erase a landed result
 *
 * A worker that commits its work and then throws in a reporting step used to
 * produce a summary saying nothing had changed. The artifact is written when
 * the work lands, not when the agent exits, so the record of what landed
 * survives the agent that landed it.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { REQUIRED_COLUMNS, parseCsv, parseTasks, type Task } from "./waves.ts";

/** The statuses a task row may carry. `stalled` is written by the supervisor, never by an agent. */
export const TASK_STATUSES = ["pending", "blocked", "running", "stalled", "done", "failed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface RunArtifact {
	readonly taskId: string;
	readonly runId: string;
	readonly status: TaskStatus;
	/** The rung actually reached, which may be lower than the row's target. */
	readonly doneRung: string;
	/** What was observed. Counts and outputs, not impressions. */
	readonly evidence: string;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly notes?: string;
}

export class MalformedArtifact extends Error {}

export function parseArtifact(json: string, path: string): RunArtifact {
	let raw: unknown;
	try {
		raw = JSON.parse(json);
	} catch (cause) {
		throw new MalformedArtifact(`${path} is not JSON: ${String(cause)}`);
	}

	if (typeof raw !== "object" || raw === null) throw new MalformedArtifact(`${path} is not an object.`);

	const record = raw as Record<string, unknown>;
	const text = (key: string): string => {
		const value = record[key];
		if (typeof value !== "string" || value === "") {
			throw new MalformedArtifact(`${path} is missing a non-empty string ${key}.`);
		}
		return value;
	};

	const status = text("status");
	if (!(TASK_STATUSES as readonly string[]).includes(status)) {
		throw new MalformedArtifact(`${path} has status ${JSON.stringify(status)}, which is not one of ${TASK_STATUSES.join(", ")}.`);
	}

	const notes = record["notes"];

	return {
		taskId: text("taskId"),
		runId: text("runId"),
		status: status as TaskStatus,
		doneRung: text("doneRung"),
		evidence: text("evidence"),
		startedAt: text("startedAt"),
		updatedAt: text("updatedAt"),
		...(typeof notes === "string" ? { notes } : {}),
	};
}

/**
 * Where an artifact was read from.
 *
 * `"main"` is this repo's own `artifacts/runs`. `worktree:<task-id-dir>` is a
 * sibling worktree's copy of the same path -- where a worker actually writes,
 * per the MANDATORY brief, because it commits inside its own worktree and that
 * commit has not reached the main tree yet. The tag exists so precedence and
 * reporting can tell the two apart without re-deriving it from the path.
 */
export type ArtifactOrigin = "main" | `worktree:${string}`;

export interface LoadedArtifact {
	readonly artifact: RunArtifact;
	readonly path: string;
	/**
	 * The file's mtime, not `updatedAt`.
	 *
	 * Staleness is judged on when the process last wrote, because a stalled
	 * agent's own timestamp is exactly the field it has stopped updating. A
	 * gauge that a hung worker can keep looking healthy on measures nothing.
	 */
	readonly writtenAtMs: number;
	readonly origin: ArtifactOrigin;
}

/**
 * Reads every artifact under `<runsDir>/<runId>/*.json`, tagged with `origin`.
 *
 * Deliberately strict: a malformed file throws rather than being skipped. That
 * is what "every artifact actually on disk parses" pins for this repo's own
 * `artifacts/runs`, and it is the right default for a directory this tool
 * owns. It is the wrong default for a *sibling worktree's* `artifacts/runs`,
 * which belongs to another live agent -- see {@link loadWorktreeArtifactsTolerant},
 * which this function intentionally does not become.
 */
export function loadArtifacts(runsDir: string, origin: ArtifactOrigin = "main"): readonly LoadedArtifact[] {
	const loaded: LoadedArtifact[] = [];

	let runIds: string[];
	try {
		runIds = readdirSync(runsDir);
	} catch {
		return [];
	}

	for (const runId of runIds) {
		let files: string[];
		try {
			files = readdirSync(`${runsDir}/${runId}`);
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const path = `${runsDir}/${runId}/${file}`;
			// Read synchronously and stat in the same pass: the mtime must be
			// the one belonging to the bytes just read, and an async gap here
			// is a window in which the agent writes again.
			loaded.push({
				artifact: parseArtifact(readFileSync(path, "utf8"), path),
				path,
				writtenAtMs: statSync(path).mtimeMs,
				origin,
			});
		}
	}

	return loaded;
}

export interface SkippedArtifact {
	readonly path: string;
	readonly error: string;
}

export interface TolerantLoadResult {
	readonly loaded: readonly LoadedArtifact[];
	readonly skipped: readonly SkippedArtifact[];
}

/**
 * Loads artifacts from a sibling worktree's `artifacts/runs`, tolerant of a
 * malformed or partially-written file.
 *
 * `loadArtifacts` stays strict on purpose -- five malformed files in this
 * repo's own `artifacts/runs` once took `bun tools/ledger.ts` down before it
 * folded a single round ("every artifact actually on disk parses" below still
 * proves that). A worktree's `artifacts/runs` is not this repo's own: it
 * belongs to another live agent, written with a non-atomic `cat > file`, and
 * one bad or half-written file there must not blind the tool to every OTHER
 * task's healthy artifact -- in that worktree or any other. So the skip is
 * per file, not per directory, and always reported back to the caller: a
 * silently dropped file is exactly the failure mode this tool exists to
 * police.
 */
export function loadWorktreeArtifactsTolerant(runsDir: string, origin: ArtifactOrigin): TolerantLoadResult {
	const loaded: LoadedArtifact[] = [];
	const skipped: SkippedArtifact[] = [];

	let runIds: string[];
	try {
		runIds = readdirSync(runsDir);
	} catch {
		return { loaded, skipped };
	}

	for (const runId of runIds) {
		let files: string[];
		try {
			files = readdirSync(`${runsDir}/${runId}`);
		} catch {
			continue;
		}

		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const path = `${runsDir}/${runId}/${file}`;
			try {
				const artifact = parseArtifact(readFileSync(path, "utf8"), path);
				const writtenAtMs = statSync(path).mtimeMs;
				loaded.push({ artifact, path, writtenAtMs, origin });
			} catch (cause) {
				skipped.push({ path, error: cause instanceof Error ? cause.message : String(cause) });
			}
		}
	}

	return { loaded, skipped };
}

export interface WorktreeRunsDir {
	readonly taskDir: string;
	readonly runsDir: string;
}

/**
 * Where this repo's sibling worktrees live.
 *
 * EZiL-Works keeps worktrees as a sibling directory of the repo itself
 * (`dirname(REPO)/basename(REPO).worktrees`, per that repo's
 * `tools/worktree.sh`). EZiL-OS keeps them INSIDE the repo instead, at
 * `.claude/worktrees` -- see `.gitignore`, which ignores `.claude/*` wholesale
 * and then un-ignores `.claude/agents/` only, so `.claude/worktrees/<task>/`
 * stays untracked while agent definitions stay committed. This is the one
 * intended change from the EZiL-Works source of this file.
 */
export function worktreesBaseDir(repoRoot: string): string {
	const repo = resolve(repoRoot);
	return join(repo, ".claude", "worktrees");
}

/**
 * Every sibling worktree's `artifacts/runs`, for the ones that currently
 * exist.
 *
 * Reached at a fixed relative path (`<worktree>/artifacts/runs`) rather than
 * an open-ended find under each worktree, which is what keeps this out of
 * `node_modules` and `.git` without needing to name them: nothing here ever
 * looks inside a worktree beyond that one path. The `BASE_DIR` listing itself
 * still skips anything literally named `node_modules` or `.git`, in case one
 * ever ends up a sibling of the worktree directories rather than inside one.
 */
export function discoverWorktreeRunsDirs(repoRoot: string): readonly WorktreeRunsDir[] {
	const baseDir = worktreesBaseDir(repoRoot);

	let entries: string[];
	try {
		entries = readdirSync(baseDir);
	} catch {
		return [];
	}

	const dirs: WorktreeRunsDir[] = [];
	for (const taskDir of entries) {
		if (taskDir === "node_modules" || taskDir === ".git") continue;

		const worktreeDir = join(baseDir, taskDir);
		try {
			if (!statSync(worktreeDir).isDirectory()) continue;
		} catch {
			continue;
		}

		const runsDir = join(worktreeDir, "artifacts", "runs");
		try {
			if (!statSync(runsDir).isDirectory()) continue;
		} catch {
			continue;
		}

		dirs.push({ taskDir, runsDir });
	}

	return dirs;
}

/**
 * Whether two artifacts carry the same information, ignoring nothing that
 * would make them different attempts.
 *
 * `taskId`/`runId` are the join key and are not compared here -- callers only
 * reach for this once those already match.
 */
function artifactContentEquals(a: RunArtifact, b: RunArtifact): boolean {
	return (
		a.status === b.status &&
		a.doneRung === b.doneRung &&
		a.evidence === b.evidence &&
		a.startedAt === b.startedAt &&
		a.updatedAt === b.updatedAt &&
		(a.notes ?? null) === (b.notes ?? null)
	);
}

export interface AllArtifactsResult {
	readonly loaded: readonly LoadedArtifact[];
	readonly skipped: readonly SkippedArtifact[];
	/** Task-id directories under `BASE_DIR` whose `artifacts/runs` was walked. */
	readonly worktreesWalked: readonly string[];
	/**
	 * Worktree files dropped because they were a checkout's copy of a file
	 * main already has -- see the doc comment on {@link loadAllArtifacts} for
	 * why this exists and is not optional.
	 */
	readonly duplicatesSkipped: number;
}

/**
 * `loadArtifacts` on the main tree's `artifacts/runs`, plus every sibling
 * worktree's, so a task running inside `EZiL-Works.worktrees/<id>/` is not
 * reported stalled just because its own commit has not reached the main tree
 * yet.
 *
 * The main tree stays strict (see {@link loadArtifacts}); each worktree is
 * walked tolerantly (see {@link loadWorktreeArtifactsTolerant}) because it is
 * not this tool's own directory to trust unconditionally.
 *
 * ## Why a worktree artifact identical to main's own is dropped, not raced
 *
 * `artifacts/runs` is committed. Measured directly across the live worktrees
 * this ran against while it was built: every worktree's checkout carries
 * whatever already-merged run artifacts existed at the commit it branched
 * from -- `kyc/K1.json` byte-identical in two different worktrees, at mtimes
 * 681 seconds apart, neither of which is when that file was actually
 * written. `git worktree add` stamps a fresh checkout at `add` time, and nine
 * times out of ten that checkout is more recent than whenever main's own
 * copy last had its mtime set. Left alone, "newest mtime wins" -- the
 * literal, correct rule for genuinely different attempts -- would let an old,
 * already-terminal artifact's checkout copy outrank main's own copy of
 * itself, for a reason that has nothing to do with anyone writing anything.
 *
 * The fix is scoped exactly to that case: a worktree file dropped ONLY when a
 * main-tree file exists for the same `(runId, taskId)` and their content is
 * identical (`artifactContentEquals`). A worktree file that genuinely differs
 * from main's -- including every fresh `running` record a worker writes for
 * its own current run, which main by definition does not have yet -- is kept
 * and competes on mtime exactly as {@link latestPerTask} already documents.
 * This does not change the mtime rule; it removes inputs that were never a
 * write in the first place.
 */
export function loadAllArtifacts(repoRoot: string): AllArtifactsResult {
	const repo = resolve(repoRoot);
	const mainRunsDir = join(repo, "artifacts", "runs");

	const mainLoaded = loadArtifacts(mainRunsDir, "main");
	const mainByKey = new Map<string, RunArtifact>();
	for (const { artifact } of mainLoaded) mainByKey.set(`${artifact.runId} ${artifact.taskId}`, artifact);

	const loaded: LoadedArtifact[] = [...mainLoaded];
	const skipped: SkippedArtifact[] = [];
	const worktreesWalked: string[] = [];
	let duplicatesSkipped = 0;

	for (const { taskDir, runsDir } of discoverWorktreeRunsDirs(repo)) {
		const result = loadWorktreeArtifactsTolerant(runsDir, `worktree:${taskDir}`);

		for (const item of result.loaded) {
			const mainMatch = mainByKey.get(`${item.artifact.runId} ${item.artifact.taskId}`);
			if (mainMatch !== undefined && artifactContentEquals(item.artifact, mainMatch)) {
				duplicatesSkipped += 1;
				continue;
			}
			loaded.push(item);
		}

		skipped.push(...result.skipped);
		worktreesWalked.push(taskDir);
	}

	return { loaded, skipped, worktreesWalked, duplicatesSkipped };
}

/**
 * The latest artifact per task, by file mtime.
 *
 * A task that was re-dispatched after a stall has two artifacts under two run
 * ids. The newer one is what happened; the older one is kept on disk because
 * the record of a failed attempt is part of the evidence, not noise to be
 * cleaned up.
 *
 * `origin` never enters this comparison, deliberately: staleness is judged on
 * mtime and only mtime (see {@link LoadedArtifact.writtenAtMs}), so the same
 * rule that keeps a hung agent's stale `updatedAt` from reading as healthy
 * also decides main-versus-worktree. A worktree's copy wins for as long as it
 * is the newer write; once the work merges, the main tree's copy is newer and
 * wins in turn -- "merged" is not a status this function reads, it is what a
 * newer main-tree mtime *means*.
 */
export function latestPerTask(artifacts: readonly LoadedArtifact[]): ReadonlyMap<string, LoadedArtifact> {
	const latest = new Map<string, LoadedArtifact>();

	for (const loaded of artifacts) {
		const existing = latest.get(loaded.artifact.taskId);
		if (existing === undefined || loaded.writtenAtMs > existing.writtenAtMs) {
			latest.set(loaded.artifact.taskId, loaded);
		}
	}

	return latest;
}

function quote(value: string): string {
	return value.includes(",") || value.includes('"') || value.includes("\n")
		? `"${value.replaceAll('"', '""')}"`
		: value;
}

/**
 * The statuses an artifact is allowed to fold into the CSV. `running` is
 * excluded on purpose: it is the worker's own claim that it is still
 * mid-flight, and folding it would either overwrite a row's actual prior
 * status with a word that means "no change happened here" or -- for a
 * worktree artifact specifically -- write a status into the CSV for work that
 * has not merged yet. `done` DOES fold even from a worktree, before merge:
 * that is still the worker's own claim, not a verified fact, but folding a
 * claim is not the same as trusting it unconditionally -- the supervisor's
 * merge check is the second gate, and this file has never been the first one.
 * `blocked` and `failed` are terminal the same way `done` is, so they fold
 * too. `pending` and `stalled` are not statuses an agent's own artifact is
 * meant to carry (`stalled` is written by the supervisor, never by an agent --
 * see the module docs), so they are excluded along with `running`.
 */
const FOLDABLE_STATUSES: ReadonlySet<TaskStatus> = new Set(["done", "failed", "blocked"]);

/**
 * Fold the ledger into the CSV.
 *
 * Only `status`, `run_id` and `evidence` move, and only for a row whose
 * winning artifact reports a {@link FOLDABLE_STATUSES foldable status}.
 * Everything else -- the title, the ownership, the dependencies, the routing
 * -- is the plan, and the plan is written by a person. An agent reporting its
 * result must not be able to enlarge its own file ownership or drop a
 * dependency on the way past.
 */
export function reconcile(csvText: string, latest: ReadonlyMap<string, LoadedArtifact>): string {
	const rows = parseCsv(csvText);
	const statusAt = REQUIRED_COLUMNS.indexOf("status");
	const runIdAt = REQUIRED_COLUMNS.indexOf("run_id");
	const evidenceAt = REQUIRED_COLUMNS.indexOf("evidence");

	const out = rows.map((cells, index) => {
		if (index === 0) return cells.join(",");

		const found = latest.get(cells[0] ?? "");
		// Two guards, learned from rows W3/W5 in round OH: task ids are reused
		// across rounds (`studio6` had a W3 and a W5 too), so an id-only join let
		// a stale artifact mark two never-dispatched rows done and stamp them with
		// the old run id. (1) A `pending` row was never dispatched: nothing can be
		// its artifact. (2) A row that already names its run folds only an
		// artifact of that run. A running row with no run id yet (older rounds
		// stamped it from the artifact) keeps folding as before.
		const rowStatus = cells[statusAt] ?? "";
		const rowRunId = cells[runIdAt] ?? "";
		const ownRun = rowRunId === "" || found?.artifact.runId === rowRunId;
		if (found !== undefined && rowStatus !== "pending" && ownRun && FOLDABLE_STATUSES.has(found.artifact.status)) {
			cells[statusAt] = found.artifact.status;
			cells[runIdAt] = found.artifact.runId;
			cells[evidenceAt] = found.artifact.evidence;
		}

		return cells.map(quote).join(",");
	});

	return `${out.join("\n")}\n`;
}

export interface Stall {
	readonly task: Task;
	readonly idleMs: number;
	readonly reason: string;
}

/** How a task came to be considered in flight. Carried so the stall reason can say which. */
export type InFlightVia = "row" | "artifact";

export interface InFlight {
	readonly task: Task;
	readonly via: InFlightVia;
	/** The task's latest artifact, or `undefined` when nothing was ever written for it. */
	readonly found: LoadedArtifact | undefined;
}

/**
 * The tasks the stall rule is capable of naming: everything that looks in flight.
 *
 * ## Why this is a separate exported function
 *
 * A stall detector fails in two different ways and only one of them is a bug in
 * the detector. It can judge a live task wrongly -- and the tests below catch
 * that. Or the set it iterates can become empty, at which point it reports no
 * stalls because it can see none, which is indistinguishable in the output from
 * there being none. That second failure is the one this repository actually
 * had: `detectStalls` inspected only rows whose status is `running`, and
 * `docs/TASKS.csv` has carried zero such rows since 2026-08-19, so the net was
 * structurally incapable of firing for ten days while reading as green.
 *
 * Splitting the predicate out means {@link stallCoverage} counts the same set
 * `detectStalls` walks rather than a restatement of it. Narrowing the rule
 * narrows the count, and the tool says so out loud. A second copy of this
 * condition written for the reporting would drift from this one and re-create
 * exactly the silence it exists to break.
 *
 * ## The two shapes, and why the second is here
 *
 * **The row says `running`.** The supervisor sets it at dispatch; the CSV is
 * written by a person, so this is in-contract. Both dispatch rounds that ever
 * happened (`c0a3c30`, 2026-08-19) did it this way.
 *
 * **The latest artifact says `running`.** A task whose own record says it is
 * mid-flight is in flight whatever the row says -- and the row is a projection
 * of the ledger, so the ledger is the fresher of the two. This shape is not
 * invented here: `118ae6dc` dispatched P2 and P3 with `pending` rows and
 * `running` artifacts. That round's artifacts were written by the *supervisor*,
 * which `ORCHESTRATION.md` now forbids because a supervisor-written record
 * collides add/add with the worker's own. The shape this branch is for is the
 * legal version of the same thing: the **agent** writing its own `running`
 * record when it starts, which has one writer and so cannot collide.
 *
 * Nothing writes that record today. This branch therefore does not revive the
 * net on its own -- see {@link stallCoverage}. It is here so the net covers the
 * dispatch shape the repository last used, rather than only the one it used
 * before that.
 */
export function inFlightTasks(tasks: readonly Task[], latest: ReadonlyMap<string, LoadedArtifact>): readonly InFlight[] {
	const inFlight: InFlight[] = [];

	for (const task of tasks) {
		const found = latest.get(task.id);

		if (task.status === "running") inFlight.push({ task, via: "row", found });
		else if (found?.artifact.status === "running") inFlight.push({ task, via: "artifact", found });
	}

	return inFlight;
}

/**
 * A task is stalled when it looks in flight and nothing has written its artifact
 * for longer than the threshold.
 *
 * A row that says `running` with **no artifact at all** counts too, and is the
 * more common case here: it is what a workflow that died with the session looks
 * like from outside. Those leave no completion marker, so absence has to be
 * treated as a signal rather than as "not started yet".
 *
 * The absence branch is deliberately not extended to `pending` rows. A pending
 * row with no artifact is the resting state of every task that has not been
 * dispatched yet -- 58 of them in `docs/TASKS.csv` right now -- so treating
 * absence as a signal there would name the whole backlog as stalled. A detector
 * that cries wolf gets ignored, which lands in the same place as one that never
 * fires. What distinguishes a dispatched-and-dead task from a never-started one
 * is a marker written at dispatch, and that marker is what is currently missing.
 */
export function detectStalls(
	tasks: readonly Task[],
	latest: ReadonlyMap<string, LoadedArtifact>,
	nowMs: number,
	idleThresholdMs: number,
): readonly Stall[] {
	const stalls: Stall[] = [];

	for (const { task, via, found } of inFlightTasks(tasks, latest)) {
		if (found === undefined) {
			// Only reachable via "row": the artifact branch needs an artifact.
			stalls.push({
				task,
				idleMs: Number.POSITIVE_INFINITY,
				reason: "row says running and no artifact was ever written; this is what a workflow that died with the session looks like",
			});
			continue;
		}

		// A terminal record landed under a row nobody folded back yet. Not a
		// stall -- the work reported. `reconcile` is what fixes the row.
		if (found.artifact.status !== "running") continue;

		const idleMs = nowMs - found.writtenAtMs;
		if (idleMs > idleThresholdMs) {
			const source = via === "row" ? "row says running" : "row does not say running but its artifact does";
			stalls.push({
				task,
				idleMs,
				reason: `${source}; no artifact write for ${Math.round(idleMs / 1000)}s (threshold ${Math.round(idleThresholdMs / 1000)}s); re-dispatch with a changed hypothesis rather than waiting on the hard timeout`,
			});
		}
	}

	return stalls;
}

/**
 * What the stall check was able to look at.
 *
 * `detectStalls` returning `[]` has two meanings and the caller cannot tell them
 * apart: *nothing is stalled*, or *nothing could have been*. This makes the
 * second one countable, so `bun tools/ledger.ts` can say which of the two it
 * just observed instead of printing a reassuring blank.
 */
export interface StallCoverage {
	readonly rowsInspected: number;
	/** Ids of the rows `detectStalls` walked. Empty means the rule can match nothing. */
	readonly inFlight: readonly string[];
	readonly byRow: number;
	readonly byArtifact: number;
	readonly artifactsSeen: number;
	/**
	 * Of `artifactsSeen`, how many of the winning (per {@link latestPerTask})
	 * artifacts were read from this repo's own `artifacts/runs` versus from a
	 * sibling worktree's. `artifactsFromMain + artifactsFromWorktree` always
	 * equals `artifactsSeen` -- this is that same total, split by origin
	 * rather than replaced by it, so a reader can check the arithmetic. A
	 * nonzero `artifactsFromWorktree` names how much of the round is still
	 * living pre-merge, which is the whole reason this split exists: it is
	 * what used to be invisible to `bun tools/ledger.ts` running from the main
	 * tree.
	 */
	readonly artifactsFromMain: number;
	readonly artifactsFromWorktree: number;
	/**
	 * Row statuses outside {@link TASK_STATUSES}, and how many rows carry each.
	 *
	 * Counted because the stall rule compares against the literal `running`.
	 * `docs/TASKS.csv` already carries `blocked-on-o9`, `blocked-on-owner` and
	 * `blocked-on-m0`, none of which the vocabulary knows -- so a row typed
	 * `in-progress` or `runnning` would be skipped in exactly the same silence,
	 * and this is the only place that would show it.
	 */
	readonly unknownStatuses: ReadonlyMap<string, number>;
}

export function stallCoverage(tasks: readonly Task[], latest: ReadonlyMap<string, LoadedArtifact>): StallCoverage {
	const inFlight = inFlightTasks(tasks, latest);
	const unknownStatuses = new Map<string, number>();

	for (const task of tasks) {
		if ((TASK_STATUSES as readonly string[]).includes(task.status)) continue;
		unknownStatuses.set(task.status, (unknownStatuses.get(task.status) ?? 0) + 1);
	}

	let artifactsFromMain = 0;
	let artifactsFromWorktree = 0;
	for (const { origin } of latest.values()) {
		if (origin === "main") artifactsFromMain += 1;
		else artifactsFromWorktree += 1;
	}

	return {
		rowsInspected: tasks.length,
		inFlight: inFlight.map(({ task }) => task.id),
		byRow: inFlight.filter(({ via }) => via === "row").length,
		byArtifact: inFlight.filter(({ via }) => via === "artifact").length,
		artifactsSeen: latest.size,
		artifactsFromMain,
		artifactsFromWorktree,
		unknownStatuses,
	};
}

/**
 * The coverage lines `bun tools/ledger.ts` prints, as data so they can be tested.
 *
 * Returned rather than logged because a test that asserts on captured stdout is
 * asserting on the console as much as on the decision, and the decision here is
 * the whole deliverable: **silence about the stall check must be impossible.**
 * Either the tool says how many rows were in flight, or it says that none could
 * be and what that costs.
 */
export function coverageReport(coverage: StallCoverage): readonly string[] {
	const counted = `${coverage.rowsInspected} row(s) inspected, ${coverage.inFlight.length} in flight (${coverage.byRow} by row, ${coverage.byArtifact} by artifact — ${coverage.artifactsFromMain} from main, ${coverage.artifactsFromWorktree} from worktrees)`;

	const lines =
		coverage.inFlight.length > 0
			? [`stall check: ${counted}`]
			: [
					`STALL CHECK NOT ACTIVE: ${counted}.`,
					"  No row says `running` and no artifact says `running`, so the stall rule has nothing it could match.",
					"  A workflow that died with the session right now would be invisible here. This is silence about a",
					"  question nobody asked, not a clean bill of health. Fix: mark a row `running` in docs/TASKS.csv when",
					"  you dispatch it, or brief the agent to write its own `running` artifact at start. See",
					'  docs/ORCHESTRATION.md "Stalls".',
				];

	if (coverage.unknownStatuses.size > 0) {
		const named = [...coverage.unknownStatuses.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([status, count]) => `${status} x${count}`)
			.join(", ");
		lines.push(
			`  note: ${[...coverage.unknownStatuses.values()].reduce((a, b) => a + b, 0)} row(s) carry a status outside the vocabulary (${named}).`,
			"  The rule matches `running` exactly, so an invented or mistyped in-flight status is skipped without comment.",
		);
	}

	return lines;
}

export const DEFAULT_IDLE_THRESHOLD_MS = 15 * 60 * 1000;

if (import.meta.main) {
	const root = `${import.meta.dir}/..`;
	const csvPath = `${root}/docs/TASKS.csv`;
	const mode = process.argv[2] ?? "report";

	const { loaded: artifacts, skipped, worktreesWalked, duplicatesSkipped } = loadAllArtifacts(root);
	for (const s of skipped) console.log(`SKIPPED  ${s.path}  ${s.error}`);

	const latest = latestPerTask(artifacts);
	const csvText = await Bun.file(csvPath).text();
	const tasks = parseTasks(csvText);

	const fromWorktrees = artifacts.filter((a) => a.origin !== "main").length;
	console.log(
		`${artifacts.length} artifact(s) across ${new Set(artifacts.map((a) => a.artifact.runId)).size} run(s)` +
			` (${artifacts.length - fromWorktrees} from main, ${fromWorktrees} from ${worktreesWalked.length} sibling worktree(s), ` +
			`${duplicatesSkipped} checkout duplicate(s) of main skipped)`,
	);

	// Printed before the stalls, and unconditionally. The reason for both: an
	// empty stall list under an empty in-flight set reads exactly like an empty
	// stall list under a healthy round, and the reader of this output has no
	// other way to tell. Saying what was inspected first makes the following
	// blank mean something.
	for (const line of coverageReport(stallCoverage(tasks, latest))) console.log(line);

	const stalls = detectStalls(tasks, latest, Date.now(), DEFAULT_IDLE_THRESHOLD_MS);
	for (const stall of stalls) console.log(`STALLED  ${stall.task.id}  ${stall.reason}`);

	// What `reconcile` would actually touch, not `latest.size`: a `running`
	// winner (including every fresh worktree artifact keeping a row in
	// flight) folds nothing, so counting it here would claim a change that
	// would not happen -- the same overstatement this file exists to refuse
	// elsewhere.
	const foldable = [...latest.values()].filter((a) => FOLDABLE_STATUSES.has(a.artifact.status)).length;

	if (mode === "apply") {
		await Bun.write(csvPath, reconcile(csvText, latest));
		console.log(`reconciled ${foldable} row(s) into ${csvPath}`);
	} else if (foldable > 0) {
		console.log(`\n${foldable} row(s) would change. Re-run with \`apply\` to write them.`);
	}

	// A dead stall check does NOT exit 1, deliberately. It cannot be fixed from
	// inside this file -- it needs a dispatch-protocol change -- so it would be
	// red on every run until someone else acts, and `tools/test.sh`'s own header
	// records where that ends: an exit code that is always non-zero stops being
	// believed, which is worse than not having one. The warning is loud in the
	// text and silent in the status; a stall that the rule actually caught is
	// still an exit 1.
	if (stalls.length > 0) process.exit(1);
}
