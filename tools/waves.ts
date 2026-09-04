/**
 * The task DAG, and the two questions it has to answer before a fan-out starts.
 *
 * `docs/TASKS.csv` is the durable record of what is to be built, who owns which
 * files, and what must finish first. It exists because background workflows die
 * with the session and leave no completion marker, so the plan cannot live in
 * the session that is executing it.
 *
 * ## The two rules this file enforces
 *
 * **Disjoint ownership within a wave.** The repository's stated rule is that a
 * task which adds a constraint must own the writers of the data it constrains,
 * and the project has paid three times for describing one interface in two
 * briefs. Two agents dispatched in the same wave holding the same file is that
 * failure, mechanised. So a wave whose rows overlap on `owns_files` is not a
 * wave -- it is a merge conflict that has not happened yet, and this refuses it.
 *
 * **No cycles.** A dependency cycle does not announce itself: the scheduler
 * simply never emits those rows, and a fan-out that silently omits a third of
 * the work looks exactly like a fan-out that finished.
 *
 * ## Why waves are computed rather than authored
 *
 * The CSV carries a `wave` column, and it is *advisory* -- it is what a human
 * reading the file expects. The wave a task actually runs in is derived from
 * `depends_on`, because those two can disagree and the dependency graph is the
 * one that is true. `checkWaveColumn()` reports the disagreements rather than
 * silently preferring one, since a stale `wave` value is a sign the plan moved
 * and the column did not.
 */

export interface Task {
	readonly id: string;
	readonly track: string;
	readonly wave: number;
	readonly title: string;
	readonly ownsFiles: readonly string[];
	readonly dependsOn: readonly string[];
	readonly agentType: string;
	readonly model: string;
	readonly effort: string;
	readonly isolation: string;
	readonly contractArtifact: string;
	readonly verifyCmd: string;
	readonly gate: string;
	readonly doneRung: string;
	readonly status: string;
	readonly runId: string;
	readonly evidence: string;
}

export const REQUIRED_COLUMNS = [
	"id",
	"track",
	"wave",
	"title",
	"owns_files",
	"depends_on",
	"agent_type",
	"model",
	"effort",
	"isolation",
	"contract_artifact",
	"verify_cmd",
	"gate",
	"done_rung",
	"status",
	"run_id",
	"evidence",
] as const;

/**
 * A minimal RFC 4180 reader: quoted fields, doubled quotes inside them, commas
 * and newlines inside quotes.
 *
 * Written rather than reached for, because the alternative -- `line.split(",")`
 * -- does not fail on a title containing a comma. It shifts every later column
 * left by one, so `model` reads as `effort` and the row still parses. A parser
 * that mis-reads quietly is worse here than one that is absent.
 */
export function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;

	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];

		if (quoted) {
			if (ch === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i += 1;
				} else {
					quoted = false;
				}
			} else {
				field += ch;
			}
			continue;
		}

		if (ch === '"') {
			quoted = true;
		} else if (ch === ",") {
			row.push(field);
			field = "";
		} else if (ch === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (ch !== "\r") {
			field += ch;
		}
	}

	if (field !== "" || row.length > 0) {
		row.push(field);
		rows.push(row);
	}

	return rows.filter((r) => r.length > 1 || (r[0] ?? "") !== "");
}

/** A `;`-separated list column. Empty means empty, not `[""]`. */
function list(value: string): readonly string[] {
	return value
		.split(";")
		.map((part) => part.trim())
		.filter((part) => part !== "");
}

export function parseTasks(text: string): readonly Task[] {
	const rows = parseCsv(text);
	const header = rows[0];

	if (header === undefined) throw new Error("docs/TASKS.csv is empty: no header row.");

	for (const [index, name] of REQUIRED_COLUMNS.entries()) {
		if (header[index] !== name) {
			throw new Error(
				`docs/TASKS.csv column ${index} is ${JSON.stringify(header[index])}, expected ${JSON.stringify(name)}. ` +
					`The column order is part of the format; a reordered file would be read wrongly rather than rejected.`,
			);
		}
	}

	return rows.slice(1).map((cells, rowIndex) => {
		if (cells.length !== REQUIRED_COLUMNS.length) {
			throw new Error(
				`docs/TASKS.csv row ${rowIndex + 2} has ${cells.length} fields, expected ${REQUIRED_COLUMNS.length}.`,
			);
		}

		const at = (index: number): string => cells[index] ?? "";
		const waveText = at(2);
		const wave = Number(waveText);

		if (!Number.isInteger(wave)) {
			throw new Error(`docs/TASKS.csv row ${rowIndex + 2}: wave ${JSON.stringify(waveText)} is not an integer.`);
		}

		return {
			id: at(0),
			track: at(1),
			wave,
			title: at(3),
			ownsFiles: list(at(4)),
			dependsOn: list(at(5)),
			agentType: at(6),
			model: at(7),
			effort: at(8),
			isolation: at(9),
			contractArtifact: at(10),
			verifyCmd: at(11),
			gate: at(12),
			doneRung: at(13),
			status: at(14),
			runId: at(15),
			evidence: at(16),
		};
	});
}

export interface Problem {
	readonly kind: "duplicate-id" | "unknown-dependency" | "cycle" | "overlapping-ownership" | "wave-column-stale";
	readonly message: string;
}

/**
 * Kahn's algorithm, kept for its by-product rather than its output: whatever it
 * cannot emit is exactly the set of rows caught in, or fed by, a cycle. That
 * set is the error message, and naming the rows is the difference between a
 * report you can act on and one that says "there is a cycle somewhere".
 */
export function computeWaves(tasks: readonly Task[]): { waves: readonly (readonly Task[])[]; unscheduled: readonly Task[] } {
	const byId = new Map(tasks.map((task) => [task.id, task]));
	const remaining = new Set(tasks.map((task) => task.id));
	const waves: Task[][] = [];

	while (remaining.size > 0) {
		const ready = [...remaining]
			.filter((id) => {
				const task = byId.get(id);
				if (task === undefined) return false;
				return task.dependsOn.every((dep) => !remaining.has(dep));
			})
			.map((id) => byId.get(id))
			.filter((task): task is Task => task !== undefined);

		if (ready.length === 0) break;

		for (const task of ready) remaining.delete(task.id);
		waves.push(ready);
	}

	return {
		waves,
		unscheduled: [...remaining].map((id) => byId.get(id)).filter((task): task is Task => task !== undefined),
	};
}

/**
 * Two tasks overlap when one owns a path the other owns, **or a path inside
 * it**. `apps/prototype/src/ui` and `apps/prototype/src/ui/button.tsx` are the
 * same conflict as two identical paths, and comparing strings for equality
 * would report the first pair as safe.
 */
function overlaps(a: string, b: string): boolean {
	if (a === b) return true;
	const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
	return longer.startsWith(`${shorter}/`);
}

export function validate(tasks: readonly Task[]): readonly Problem[] {
	const problems: Problem[] = [];
	const seen = new Set<string>();

	for (const task of tasks) {
		if (seen.has(task.id)) {
			problems.push({ kind: "duplicate-id", message: `${task.id} appears more than once.` });
		}
		seen.add(task.id);
	}

	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			if (!seen.has(dep)) {
				problems.push({
					kind: "unknown-dependency",
					message: `${task.id} depends on ${dep}, which is not a row in this file.`,
				});
			}
		}
	}

	const { waves, unscheduled } = computeWaves(tasks);

	if (unscheduled.length > 0) {
		problems.push({
			kind: "cycle",
			message:
				`these rows can never be scheduled, so they are in or behind a dependency cycle: ` +
				unscheduled.map((task) => task.id).join(", "),
		});
	}

	for (const [index, wave] of waves.entries()) {
		/*
		 * Finished work owns nothing.
		 *
		 * `owns_files` is a claim about what a task may WRITE while it runs, and
		 * a wave-wide directory claim is the right shape for that -- P1b owned
		 * `packages/db` because it restructured the package. Once it is done the
		 * claim is spent, and holding it forever means every later task touching
		 * a file under that directory is reported as a collision with something
		 * that finished days ago.
		 *
		 * Studio 6 is where that bit: two of its tasks were refused for
		 * overlapping with pin tasks that were already merged. The overlap check
		 * exists to stop two agents writing the same file at the same time, and
		 * a completed task is not going to write anything.
		 */
		const dispatched = wave.filter((task) => task.status !== "done");

		for (let i = 0; i < dispatched.length; i += 1) {
			for (let j = i + 1; j < dispatched.length; j += 1) {
				const left = dispatched[i];
				const right = dispatched[j];
				if (left === undefined || right === undefined) continue;

				for (const a of left.ownsFiles) {
					for (const b of right.ownsFiles) {
						if (overlaps(a, b)) {
							problems.push({
								kind: "overlapping-ownership",
								message:
									`wave ${index} dispatches ${left.id} and ${right.id} together, and both own ` +
									`${a === b ? a : `${a} / ${b}`}. Split the wave or give one task both sides.`,
							});
						}
					}
				}
			}
		}
	}

	return problems;
}

/** Advisory-column drift, reported separately because it does not block a run. */
export function checkWaveColumn(tasks: readonly Task[]): readonly Problem[] {
	const { waves } = computeWaves(tasks);
	const problems: Problem[] = [];

	for (const [computed, wave] of waves.entries()) {
		for (const task of wave) {
			if (task.wave !== computed) {
				problems.push({
					kind: "wave-column-stale",
					message: `${task.id} is written as wave ${task.wave} but its dependencies put it in wave ${computed}.`,
				});
			}
		}
	}

	return problems;
}

/**
 * The definition-of-done ladder.
 *
 * "Done" is the single most expensive ambiguity in this business. A worker
 * says a feature is built; an operator reads that as working for the people it
 * was built for; the two are separated by four rungs of this ladder and a
 * disagreement about a day's pay.
 *
 * Each acceptance item names the rung it must reach, so the disagreement
 * happens in the morning while the contract is being agreed, rather than in
 * the evening when one side has already done the work.
 *
 * The order is meaningful: each rung entails the ones before it. Something
 * DEPLOYED is necessarily COMMITTED. That ordering is what lets a verdict say
 * "reached STATIC_CHECKS_PASS, required DEPLOYED" instead of a bare "no".
 *
 * Ported from EZiL-Works's `packages/contracts/src/ladder.ts` and inlined here
 * rather than split into its own file: EZiL-OS has no `packages/contracts` for
 * it to live in, and it is not in this task's `owns_files`.
 */
export const DONE_LADDER = [
	/** A plan exists and is agreed. Nothing has been written. */
	"DESIGNED",
	/** Code exists in the working tree. It may not run. */
	"CODE_PRESENT",
	/** It is committed to the named branch, so it can be looked at. */
	"COMMITTED",
	/** Types, lints and builds pass. Still no evidence it does anything. */
	"STATIC_CHECKS_PASS",
	/** The worker ran it and captured output. Their own machine, their own claim. */
	"WORKER_RUNTIME_EVIDENCE",
	/** A test that the worker did not write, or a run they did not perform, passes. */
	"INDEPENDENT_TEST_PASS",
	/** It is deployed somewhere reachable. */
	"DEPLOYED",
	/** It works in the environment it was built for, checked there. */
	"TARGET_ENVIRONMENT_CONFIRMED",
	/** A real user achieved the outcome. The only rung that is evidence of value. */
	"USER_OUTCOME_CONFIRMED",
] as const;

export type DoneRung = (typeof DONE_LADDER)[number];

/**
 * How high a rung sits. Higher entails lower.
 *
 * Returned rather than exposed as a map so a caller cannot be handed a rung
 * string that is not on the ladder and get `undefined` back silently.
 */
export function rungHeight(rung: DoneRung): number {
	return DONE_LADDER.indexOf(rung);
}

/** Whether evidence reaching `reached` satisfies an item requiring `required`. */
export function rungSatisfies(reached: DoneRung, required: DoneRung): boolean {
	return rungHeight(reached) >= rungHeight(required);
}

if (import.meta.main) {
	const path = process.argv[2] ?? "docs/TASKS.csv";
	const tasks = parseTasks(await Bun.file(path).text());
	const problems = validate(tasks);
	const { waves, unscheduled } = computeWaves(tasks);

	console.log(`${tasks.length} tasks in ${path}\n`);

	for (const [index, wave] of waves.entries()) {
		const open = wave.filter((task) => task.status !== "done");
		console.log(`wave ${index}  (${wave.length} tasks, ${open.length} open)`);
		for (const task of wave) {
			const mark = task.status === "done" ? "x" : task.status === "blocked" ? "-" : " ";
			console.log(`  [${mark}] ${task.id.padEnd(5)} ${task.model.padEnd(7)} ${task.effort.padEnd(6)} ${task.title}`);
		}
		console.log("");
	}

	if (unscheduled.length > 0) {
		console.log(`unscheduled: ${unscheduled.map((task) => task.id).join(", ")}\n`);
	}

	for (const problem of checkWaveColumn(tasks)) console.log(`note:  ${problem.message}`);

	if (problems.length > 0) {
		console.error(`\n${problems.length} problem(s):`);
		for (const problem of problems) console.error(`  ${problem.kind}: ${problem.message}`);
		process.exit(1);
	}

	console.log("no ownership overlaps, no cycles, every dependency resolves.");
}
