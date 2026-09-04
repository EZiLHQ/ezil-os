import { describe, expect, it } from "bun:test";

import { DONE_LADDER, REQUIRED_COLUMNS, checkWaveColumn, computeWaves, parseCsv, parseTasks, rungHeight, rungSatisfies, validate } from "./waves.ts";

/**
 * Every refusal here is paired with the case it must accept.
 *
 * The repository's standard says why: a checker that rejects everything passes
 * every negative assertion, and so does a typo in the property name it reads.
 * "no overlap was reported" is only evidence if something else in the same file
 * shows an overlap *being* reported.
 */

const HEADER = REQUIRED_COLUMNS.join(",");

function csv(...rows: readonly string[]): string {
	return `${HEADER}\n${rows.join("\n")}\n`;
}

/** id, deps and owned files are what the tests vary; the rest is ballast. */
function row(id: string, dependsOn: string, ownsFiles: string, wave = "0"): string {
	return `${id},A,${wave},title for ${id},${ownsFiles},${dependsOn},claude,sonnet,high,none,,,,COMMITTED,pending,,`;
}

describe("reading the file", () => {
	it("keeps a comma that is inside a quoted field in the field it belongs to", () => {
		const rows = parseCsv('a,b,c\n1,"two, and a half",3\n');

		expect(rows[1]).toEqual(["1", "two, and a half", "3"]);
	});

	it("reads a doubled quote inside a quoted field as one quote", () => {
		const rows = parseCsv('a\n"he said ""no"""\n');

		expect(rows[1]?.[0]).toBe('he said "no"');
	});

	it("refuses a row with the wrong number of fields rather than filling the gap", () => {
		expect(() => parseTasks(csv("B1,A,0,short row"))).toThrow(/has 4 fields, expected 17/);
	});

	it("refuses a reordered header, because a reordered file reads wrongly rather than failing", () => {
		const swapped = ["track", "id", ...REQUIRED_COLUMNS.slice(2)].join(",");

		expect(() => parseTasks(`${swapped}\n`)).toThrow(/column 0 is "track", expected "id"/);
	});

	it("refuses a wave that is not an integer", () => {
		expect(() => parseTasks(csv(row("B1", "", "a.ts", "soon")))).toThrow(/is not an integer/);
	});

	it("reads the real docs/TASKS.csv", async () => {
		const tasks = parseTasks(await Bun.file(`${import.meta.dir}/../docs/TASKS.csv`).text());

		expect(tasks.length).toBeGreaterThan(20);
		// "B1" (EZiL-Works' row id) replaced with "O1", EZiL-OS's own -- the two
		// repos' plans do not share a task-id vocabulary. See O2's worker report
		// for why this line differs from the EZiL-Works source.
		expect(tasks.map((task) => task.id)).toContain("O1");
	});
});

describe("overlapping file ownership inside one wave", () => {
	it("reports two tasks in the same wave that own the same file", () => {
		const problems = validate(parseTasks(csv(row("T1", "", "packages/db/src/client.ts"), row("T2", "", "packages/db/src/client.ts"))));

		expect(problems.map((problem) => problem.kind)).toContain("overlapping-ownership");
		expect(problems[0]?.message).toContain("packages/db/src/client.ts");
	});

	it("reports a directory owned by one task and a file inside it owned by another", () => {
		const problems = validate(parseTasks(csv(row("T1", "", "apps/prototype/src/ui"), row("T2", "", "apps/prototype/src/ui/button.tsx"))));

		expect(problems.map((problem) => problem.kind)).toContain("overlapping-ownership");
	});

	it("does NOT report two paths that merely share a prefix without nesting", () => {
		// `src/ui` and `src/uikit` start the same and are different directories.
		// Without the separator in the check, this is a false positive -- and a
		// checker that reports overlaps everywhere passes the tests above.
		const problems = validate(parseTasks(csv(row("T1", "", "apps/prototype/src/ui"), row("T2", "", "apps/prototype/src/uikit"))));

		expect(problems).toEqual([]);
	});

	it("does NOT report the same file owned by tasks in DIFFERENT waves", () => {
		// This is the positive control for the whole check. Sequential tasks are
		// expected to hand a file on; only concurrent ones collide. A checker
		// that ignored waves would flag this, and would still pass every test
		// above it.
		const problems = validate(parseTasks(csv(row("T1", "", "packages/db/src/client.ts"), row("T2", "T1", "packages/db/src/client.ts", "1"))));

		expect(problems).toEqual([]);
	});

	it("does NOT report two tasks in one wave that own nothing in common", () => {
		const problems = validate(parseTasks(csv(row("T1", "", "packages/db/src/client.ts"), row("T2", "", "packages/contracts/src/review.ts"))));

		expect(problems).toEqual([]);
	});
});

describe("dependency cycles", () => {
	it("names the rows in a two-task cycle instead of reporting that one exists", () => {
		const problems = validate(parseTasks(csv(row("T1", "T2", "a.ts"), row("T2", "T1", "b.ts"))));

		const cycle = problems.find((problem) => problem.kind === "cycle");
		expect(cycle?.message).toContain("T1");
		expect(cycle?.message).toContain("T2");
	});

	it("names a task that is not itself in the cycle but sits behind one", () => {
		const problems = validate(parseTasks(csv(row("T1", "T2", "a.ts"), row("T2", "T1", "b.ts"), row("T3", "T1", "c.ts"))));

		expect(problems.find((problem) => problem.kind === "cycle")?.message).toContain("T3");
	});

	it("reports a task depending on itself", () => {
		const problems = validate(parseTasks(csv(row("T1", "T1", "a.ts"))));

		expect(problems.map((problem) => problem.kind)).toContain("cycle");
	});

	it("does NOT report a long acyclic chain, which is what a cycle is being distinguished from", () => {
		const problems = validate(parseTasks(csv(row("T1", "", "a.ts"), row("T2", "T1", "b.ts", "1"), row("T3", "T2", "c.ts", "2"), row("T4", "T3", "d.ts", "3"))));

		expect(problems).toEqual([]);
		expect(computeWaves(parseTasks(csv(row("T1", "", "a.ts"), row("T2", "T1", "b.ts", "1"), row("T3", "T2", "c.ts", "2"), row("T4", "T3", "d.ts", "3")))).waves).toHaveLength(4);
	});
});

describe("other refusals", () => {
	it("reports a duplicate id", () => {
		const problems = validate(parseTasks(csv(row("T1", "", "a.ts"), row("T1", "", "b.ts"))));

		expect(problems.map((problem) => problem.kind)).toContain("duplicate-id");
	});

	it("reports a dependency on a row that does not exist", () => {
		const problems = validate(parseTasks(csv(row("T1", "GHOST", "a.ts"))));

		expect(problems.find((problem) => problem.kind === "unknown-dependency")?.message).toContain("GHOST");
	});
});

describe("waves are computed from dependencies, not read from the column", () => {
	it("puts independent tasks in one wave and dependents in the next", () => {
		const { waves } = computeWaves(parseTasks(csv(row("T1", "", "a.ts"), row("T2", "", "b.ts"), row("T3", "T1;T2", "c.ts", "1"))));

		expect(waves[0]?.map((task) => task.id).sort()).toEqual(["T1", "T2"]);
		expect(waves[1]?.map((task) => task.id)).toEqual(["T3"]);
	});

	it("reports a wave column that disagrees with the graph, rather than preferring one silently", () => {
		const notes = checkWaveColumn(parseTasks(csv(row("T1", "", "a.ts"), row("T2", "T1", "b.ts", "7"))));

		expect(notes[0]?.message).toContain("written as wave 7");
		expect(notes[0]?.message).toContain("wave 1");
	});

	it("says nothing when the column agrees, so the check above is not just always talking", () => {
		expect(checkWaveColumn(parseTasks(csv(row("T1", "", "a.ts"), row("T2", "T1", "b.ts", "1"))))).toEqual([]);
	});
});

describe("the real docs/TASKS.csv", () => {
	it("has no overlapping ownership, no cycles, and every dependency resolves", async () => {
		const tasks = parseTasks(await Bun.file(`${import.meta.dir}/../docs/TASKS.csv`).text());
		const problems = validate(tasks);

		expect(problems.map((problem) => `${problem.kind}: ${problem.message}`)).toEqual([]);
	});
});

/** `row()`, with the status column set — completion is what these tests vary. */
function rowWithStatus(id: string, ownsFiles: string, status: string): string {
	return `${id},A,0,title for ${id},${ownsFiles},,claude,sonnet,high,none,,,,COMMITTED,${status},,`;
}

describe("a finished task owns nothing", () => {
	const overlaps = (csvText: string): readonly unknown[] =>
		validate(parseTasks(csv(csvText))).filter((problem) => problem.kind === "overlapping-ownership");

	it("does not report a collision between a done task and a pending one", () => {
		// `owns_files` is a claim about what a task may WRITE while it runs, and
		// a directory-wide claim is right for a restructuring task. Held after
		// completion it makes every later task touching that directory look like
		// a collision with work that merged days ago -- which is what happened
		// when Studio 6's rows met the pin's.
		expect(
			overlaps(
				[
					rowWithStatus("P1b", "packages/db", "done"),
					rowWithStatus("S6-3", "packages/db/src/repositories/people.ts", "pending"),
				].join("\n"),
			),
		).toEqual([]);
	});

	it("still reports a collision between two tasks that will both run", () => {
		// The control. Had the check simply been loosened rather than made to
		// turn on completion, this would pass too and the rule would be gone.
		expect(
			overlaps(
				[
					rowWithStatus("A1", "packages/db", "pending"),
					rowWithStatus("A2", "packages/db/src/repositories/people.ts", "pending"),
				].join("\n"),
			),
		).not.toEqual([]);
	});
});

describe("the done-ladder inlined from EZiL-Works' packages/contracts/src/ladder.ts", () => {
	it("carries the nine rungs, in order", () => {
		expect(DONE_LADDER).toEqual([
			"DESIGNED",
			"CODE_PRESENT",
			"COMMITTED",
			"STATIC_CHECKS_PASS",
			"WORKER_RUNTIME_EVIDENCE",
			"INDEPENDENT_TEST_PASS",
			"DEPLOYED",
			"TARGET_ENVIRONMENT_CONFIRMED",
			"USER_OUTCOME_CONFIRMED",
		]);
	});

	it("says a higher rung satisfies a lower requirement", () => {
		expect(rungSatisfies("DEPLOYED", "COMMITTED")).toBe(true);
	});

	it("does NOT say a lower rung satisfies a higher requirement -- the control on the assertion above", () => {
		expect(rungSatisfies("COMMITTED", "DEPLOYED")).toBe(false);
	});

	it("orders rungHeight the same way the array is written", () => {
		expect(rungHeight("DESIGNED")).toBe(0);
		expect(rungHeight("USER_OUTCOME_CONFIRMED")).toBe(DONE_LADDER.length - 1);
	});
});
