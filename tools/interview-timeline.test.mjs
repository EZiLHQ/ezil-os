/**
 * Tests for tools/interview-timeline.mjs and tools/interview.mjs against the frozen
 * contract (docs/contracts/interview-evidence-v1.*). Run:
 *
 *   node --test tools/interview-timeline.test.mjs
 *
 * No network and no staging: the CLI is driven with a stub fetch and a stub git.
 * Every negative assertion has a positive control next to it, and asserts on the
 * message or the rule name, not on "it threw".
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { main as interviewMain, pushTemplate } from "./interview.mjs";
import {
	computeObservations,
	excerpt,
	lastUserText,
	loadContract,
	main as timelineMain,
	mapPushRef,
	MergeError,
	mergeEvidence,
	renderMarkdown,
	validateEvent,
	validateSchema,
	validateTimeline,
} from "./interview-timeline.mjs";

const TOOLS = fileURLToPath(new URL(".", import.meta.url));
const { vectors, typeSource } = loadContract();
const VALID = vectors.timeline.valid;
const clone = (v) => JSON.parse(JSON.stringify(v));
const scratch = mkdtempSync(join(tmpdir(), "interview-timeline-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function capture() {
	const chunks = [];
	return { write: (s) => { chunks.push(String(s)); return true; }, text: () => chunks.join("") };
}

/** Run `validate` in-process on a timeline object. */
function validateFile(timeline, name = "t.json") {
	const file = join(scratch, name);
	writeFileSync(file, typeof timeline === "string" ? timeline : JSON.stringify(timeline));
	const stdout = capture();
	const stderr = capture();
	const code = timelineMain(["validate", file], { stdout, stderr });
	return { code, stdout: stdout.text(), stderr: stderr.text() };
}

// ---------------------------------------------------------------------------
// Vectors: valid timeline, invalid envelopes, cross-record patches
// ---------------------------------------------------------------------------

describe("validate: the vectors", () => {
	test("timeline.valid validates and exits 0 (in process and as a real process)", () => {
		const r = validateFile(VALID);
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /^valid: 19 events/);
		const file = join(scratch, "valid-spawn.json");
		writeFileSync(file, JSON.stringify(VALID));
		const proc = spawnSync(process.execPath, [join(TOOLS, "interview-timeline.mjs"), "validate", file], { env: { PATH: process.env.PATH }, encoding: "utf8" });
		assert.equal(proc.status, 0, proc.stderr);
	});

	test("the schema-derived type table equals the vectors' closed list and bySource", () => {
		assert.deepEqual([...typeSource.keys()], vectors.types.closed);
		assert.equal(typeSource.size, 18);
		for (const [type, source] of typeSource) assert.ok(vectors.types.bySource[source].includes(type), `${type} pairs with ${source}`);
	});

	test("every envelope.valid event is accepted (positive control for the rejections below)", () => {
		assert.equal(vectors.envelope.valid.length, 19);
		for (const event of vectors.envelope.valid) assert.deepEqual(validateEvent(event), [], event.type);
	});

	// Each invalid vector must be rejected with a message naming the rule that broke.
	const RULE = {
		"unknown type": /\.type: closed-types: unknown event type "input\.idle"/,
		"server-only type from the wrong source": /\.source: source-type-pairing: type repo\.frozen belongs to source works, not os/,
		"extra envelope key": /^\$: additionalProperties: unexpected key "extra"/,
		"extra data key": /^\$\.data: additionalProperties: unexpected key "keystrokes"/,
		"missing data key": /^\$\.data: required: missing key "toolCalls"/,
		"seq 0": /^\$\.seq: minimum: must be >= 1 \(got 0\)/,
		"at without milliseconds": /^\$\.at: pattern: /,
		"at not UTC": /^\$\.at: pattern: /,
		"uppercase interviewId": /^\$\.interviewId: pattern: /,
		"v 2": /^\$\.v: const: must equal 1 \(got 2\)/,
		"clientAt on a server type": /^\$: additionalProperties: unexpected key "clientAt"/,
		"turn_start not derived": /^\$\.data\.derived: const: must equal true/,
		"idle bucket outside the list": /^\$\.data\.bucket: enum: must be one of /,
		"notice sha mismatch": /^\$\.data\.noticeSha256: const: /,
		"grant not presence-gated": /^\$\.data\.presenceGated: const: must equal true/,
		"purged capture with content": /^\$\.data\.content: type: must be null .*\(if\/then\)/,
		"attribution assignment (dropped in this slice)": /^\$\.data\.attribution: const: must equal "subject_window"/,
	};

	test("every envelope.invalid event is rejected, naming its rule", () => {
		const invalid = vectors.envelope.invalid;
		assert.equal(invalid.length, Object.keys(RULE).length);
		for (const { why, event } of invalid) {
			assert.ok(RULE[why], `a rule pattern exists for "${why}"`);
			const errors = validateEvent(event);
			assert.ok(errors.length > 0, `${why}: rejected`);
			assert.ok(errors.some((line) => RULE[why].test(line)), `${why}: no line matches ${RULE[why]} in ${JSON.stringify(errors)}`);
			for (const line of errors) assert.ok(!/[\r\n]/.test(line), `${why}: one error per line`);
		}
	});

	test("an invalid event inside a timeline is reported with its index and exits 1", () => {
		const t = clone(VALID);
		const index = t.events.findIndex((e) => e.type === "presence.idle");
		t.events[index].data.bucket = "5-15m";
		const r = validateFile(t);
		assert.equal(r.code, 1);
		assert.match(r.stderr, new RegExp(`^\\$\\.events\\[${index}\\]\\.data\\.bucket: enum: `, "m"));
	});

	// The five cross-record patches of vectors.timeline.invalidCrossRecord.
	const PATCH = {
		"seq gap in os": [(t) => { t.events = t.events.filter((e) => !(e.source === "os" && e.seq === 5)); }, /seq-gapless: source os .*missing 5/],
		"events out of order": [(t) => { [t.events[0], t.events[1]] = [t.events[1], t.events[0]]; }, /ordering: /],
		"interviewId disagrees": [(t) => { t.events[0].interviewId = "11111111-1111-4111-8111-111111111111"; }, /interviewId-agreement: /],
		"pushTestRuns 1": [(t) => { t.sources.works.pushTestRuns = 1; }, /^\$\.sources\.works\.pushTestRuns: const: must equal 0 \(got 1\)/m],
		"source count disagrees": [(t) => { t.sources.gateway.count = 3; }, /source-count: declared 3 but the timeline has 2 gateway events/],
	};

	test("every timeline.invalidCrossRecord patch makes validate exit 1 with its rule", () => {
		assert.equal(vectors.timeline.invalidCrossRecord.length, Object.keys(PATCH).length);
		for (const { why } of vectors.timeline.invalidCrossRecord) {
			const [apply, rule] = PATCH[why];
			const t = clone(VALID);
			apply(t);
			const r = validateFile(t);
			assert.equal(r.code, 1, `${why}: exit 1`);
			assert.match(r.stderr, rule, why);
			assert.ok(r.stderr.trimEnd().split("\n").every((line) => line.length > 0), `${why}: lines`);
		}
	});

	test("seq is a set rule, not a timeline-adjacency rule: a derived turn_start dated before a lower seq is valid", () => {
		const t = clone(VALID);
		const heartbeat = t.events.find((e) => e.source === "os" && e.seq === 8);
		heartbeat.at = "2026-11-22T09:07:59.000Z"; // after turn_start (os seq 9) at :58, though seq 8 < 9
		t.events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
		const r = validateFile(t);
		assert.equal(r.code, 0, r.stderr);
		// Positive control: a duplicate seq is still refused.
		const dup = clone(VALID);
		dup.events.find((e) => e.source === "os" && e.seq === 12).seq = 11;
		assert.match(validateFile(dup).stderr, /seq-gapless: source os has seq 11 more than once/);
	});

	test("cannotBeKnown must be the four fixed strings", () => {
		const t = clone(VALID);
		t.cannotBeKnown[1] = "Something else.";
		assert.match(validateFile(t).stderr, /cannotBeKnown: must be the four fixed strings/);
	});

	test("usage and unreadable input", () => {
		const run = (...argv) => {
			const stderr = capture();
			const stdout = capture();
			return { code: timelineMain(argv, { stdout, stderr }), stderr: stderr.text(), stdout: stdout.text() };
		};
		assert.equal(run().code, 64);
		assert.equal(run("validate").code, 64);
		assert.equal(run("check", "x").code, 64);
		assert.equal(run("validate", "a", "b").code, 64);
		assert.equal(run("--help").code, 0);
		assert.match(run("--help").stdout, /Usage: node tools\/interview-timeline\.mjs validate FILE/);
		const notJson = join(scratch, "not.json");
		writeFileSync(notJson, "{nope");
		const r = run("validate", notJson);
		assert.equal(r.code, 1);
		assert.match(r.stderr, /not\.json: /);
	});
});

// ---------------------------------------------------------------------------
// The JSON Schema subset
// ---------------------------------------------------------------------------

describe("schema subset", () => {
	const root = { $defs: { n: { type: "integer", minimum: 1 } } };
	const check = (schema, value) => validateSchema(schema, root, value);

	test("type distinguishes integer, boolean, object, array and null", () => {
		assert.deepEqual(check({ type: "integer" }, 3), []);
		assert.match(check({ type: "integer" }, 3.5)[0], /type: must be integer/);
		assert.match(check({ type: "integer" }, true)[0], /type: must be integer/);
		assert.match(check({ type: "object" }, [])[0], /type: must be object \(got array\)/);
		assert.match(check({ type: "object" }, null)[0], /type: must be object \(got null\)/);
		assert.deepEqual(check({ type: "null" }, null), []);
	});

	test("$ref, const, enum, pattern, length, range, items, required, additionalProperties", () => {
		assert.deepEqual(check({ $ref: "#/$defs/n" }, 2), []);
		assert.match(check({ $ref: "#/$defs/n" }, 0)[0], /minimum: must be >= 1/);
		assert.match(check({ const: "a" }, "b")[0], /const: must equal "a"/);
		assert.match(check({ enum: ["a", "b"] }, "c")[0], /enum: must be one of "a", "b"/);
		assert.match(check({ pattern: "^a+$" }, "ab")[0], /pattern: /);
		assert.match(check({ minLength: 2 }, "a")[0], /minLength: length 1 < 2/);
		assert.match(check({ maxLength: 1 }, "😀😀")[0], /maxLength: length 2 > 1/);
		assert.match(check({ maximum: 5 }, 6)[0], /maximum: must be <= 5/);
		assert.match(check({ minItems: 2 }, [1])[0], /minItems: 1 items < 2/);
		assert.match(check({ maxItems: 1 }, [1, 2])[0], /maxItems: 2 items > 1/);
		assert.match(check({ items: { type: "string" } }, ["a", 2])[0], /^\$\[1\]: type: /);
		const obj = { type: "object", required: ["a"], properties: { a: { type: "string" } }, additionalProperties: false };
		assert.deepEqual(check(obj, { a: "x" }), []);
		assert.match(check(obj, {})[0], /required: missing key "a"/);
		assert.match(check(obj, { a: "x", b: 1 })[0], /additionalProperties: unexpected key "b"/);
	});

	test("oneOf needs exactly one branch; if/then/else picks the branch", () => {
		assert.deepEqual(check({ oneOf: [{ type: "string" }, { type: "null" }] }, null), []);
		assert.match(check({ oneOf: [{ type: "string" }, { type: "null" }] }, 1)[0], /oneOf: no branch matched/);
		assert.match(check({ oneOf: [{ type: "integer" }, { minimum: 0 }] }, 1)[0], /oneOf: 2 branches matched/);
		const cond = { if: { properties: { k: { const: 1 } } }, then: { required: ["a"] }, else: { required: ["b"] } };
		assert.deepEqual(check(cond, { k: 1, a: 1 }), []);
		assert.match(check(cond, { k: 1 })[0], /required: missing key "a" \(if\/then\)/);
		assert.match(check(cond, { k: 2 })[0], /required: missing key "b" \(if\/else\)/);
	});

	test("a keyword outside the subset throws instead of passing silently", () => {
		assert.throws(() => check({ allOf: [] }, 1), /unsupported schema keyword allOf/);
	});
});

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Split the vectors' valid events into the three source responses of sections 5, 7.3 and 8. */
function evidenceFrom(events, identity) {
	const of = (source) => clone(events.filter((e) => e.source === source));
	const interviewId = identity.interviewId;
	return {
		works: { v: 1, interviewId, pushTestRuns: 0, events: of("works") },
		os: { v: 1, interviewId, identity, events: of("os") },
		gateway: {
			v: 1,
			interviewId,
			consent: { authUserId: identity.osUserId, grantedAt: "2026-11-22T09:05:30.000Z", revokedAt: "2026-11-22T09:45:01.000Z" },
			events: of("gateway"),
		},
	};
}

/** A fixed, reproducible shuffle (a linear congruential generator; no Math.random). */
function shuffle(list, seed) {
	const out = [...list];
	let state = seed;
	for (let i = out.length - 1; i > 0; i--) {
		state = (state * 1103515245 + 12345) % 2147483648;
		const j = state % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

describe("merge", () => {
	const generated = new Date(VALID.generatedAt);

	test("shuffled source responses merge to exactly timeline.valid, in (at, works<os<gateway, seq) order", () => {
		for (const seed of [1, 7, 42, 2026]) {
			const ev = evidenceFrom(VALID.events, VALID.identity);
			for (const body of Object.values(ev)) body.events = shuffle(body.events, seed);
			const unshuffled = evidenceFrom(VALID.events, VALID.identity);
			assert.notDeepEqual(ev.os.events, unshuffled.os.events, `seed ${seed} actually reorders the os events`);
			const merged = mergeEvidence(ev, { now: () => generated });
			assert.deepEqual(merged.events, VALID.events);
			assert.deepEqual(merged.sources, VALID.sources);
			assert.deepEqual(merged, VALID);
			assert.deepEqual(validateTimeline(merged), []);
		}
	});

	test("ties on `at` break by source then seq (09:06:40 os 4-7; 09:08:00 gateway 1-2 after works)", () => {
		const merged = mergeEvidence(evidenceFrom(VALID.events, VALID.identity), { now: () => generated });
		const at = (ts) => merged.events.filter((e) => e.at === ts).map((e) => `${e.source}${e.seq}`);
		assert.deepEqual(at("2026-11-22T09:06:40.000Z"), ["os4", "os5", "os6", "os7"]);
		assert.deepEqual(at("2026-11-22T09:08:00.000Z"), ["gateway1", "gateway2"]);
		// A works and an os event at the same instant: works first.
		const ev = evidenceFrom(VALID.events, VALID.identity);
		ev.works.events.find((e) => e.seq === 3).at = "2026-11-22T09:06:30.000Z"; // same as os computer.opened
		const tied = mergeEvidence(ev, { now: () => generated }).events.filter((e) => e.at === "2026-11-22T09:06:30.000Z");
		assert.deepEqual(tied.map((e) => `${e.source}${e.seq}`), ["works3", "os3"]);
	});

	test("the gateway may be absent (no consent record): zero gateway events, still valid", () => {
		const ev = evidenceFrom(VALID.events.filter((e) => e.source !== "gateway"), VALID.identity);
		const merged = mergeEvidence({ ...ev, gateway: null }, { now: () => generated });
		assert.equal(merged.sources.gateway.count, 0);
		assert.deepEqual(validateTimeline(merged), []);
	});

	test("refuses responses that disagree on interviewId or on the member subject", () => {
		const ev = evidenceFrom(VALID.events, VALID.identity);
		ev.works.interviewId = "11111111-1111-4111-8111-111111111111";
		assert.throws(() => mergeEvidence(ev), (e) => e instanceof MergeError && /works evidence interviewId/.test(e.message));
		const ev2 = evidenceFrom(VALID.events, VALID.identity);
		ev2.gateway.consent.authUserId = "22222222-2222-4222-8222-222222222222";
		assert.throws(() => mergeEvidence(ev2), (e) => e instanceof MergeError && /authUserId differs/.test(e.message));
		assert.doesNotThrow(() => mergeEvidence(evidenceFrom(VALID.events, VALID.identity)));
	});

	test("a nonzero pushTestRuns is carried through so validate reports it", () => {
		const ev = evidenceFrom(VALID.events, VALID.identity);
		ev.works.pushTestRuns = 2;
		const merged = mergeEvidence(ev, { now: () => generated });
		assert.equal(merged.sources.works.pushTestRuns, 2);
		assert.match(validateTimeline(merged).join("\n"), /pushTestRuns: const: must equal 0 \(got 2\)/);
	});
});

// ---------------------------------------------------------------------------
// Observations (vectors.observationRule)
// ---------------------------------------------------------------------------

const REQ = "9d8e7f60-1a2b-4c3d-8e9f-a0b1c2d3e4f5";
let seqCounter = 0;
const osEvent = (type, at, data) => ({ v: 1, interviewId: VALID.interviewId, source: "os", seq: ++seqCounter, type, at, data });
const turn = (from, to, requestId = REQ) => [
	osEvent("agent.turn_start", from, { requestId, derived: true }),
	osEvent("agent.turn_end", to, { requestId, gatewayRequestId: null, modelAlias: "m", durationMs: Date.parse(to) - Date.parse(from), outcome: "completed", toolCalls: { read: 0, search: 0, write: 0, other: 0 } }),
];
const T = (s) => `2026-11-22T09:00:${s}.000Z`;

describe("observations", () => {
	test("a turn overlapping a hidden tab is agent_turn_while_hidden, with the overlap as from/to", () => {
		const events = [osEvent("tab.visibility", T("00"), { state: "hidden" }), osEvent("tab.visibility", T("10"), { state: "visible" }), ...turn(T("05"), T("15"))];
		assert.deepEqual(computeObservations(events), [{ kind: "agent_turn_while_hidden", from: T("05"), to: T("10"), label: "observation", refs: [REQ] }]);
	});

	test("a turn overlapping a blurred window is agent_turn_while_blurred (open span runs to the end of the record)", () => {
		const events = [osEvent("window.focus", T("00"), { focused: false }), ...turn(T("05"), T("15"))];
		assert.deepEqual(computeObservations(events), [{ kind: "agent_turn_while_blurred", from: T("05"), to: T("15"), label: "observation", refs: [REQ] }]);
	});

	test("a turn overlapping presence.idle >5m is agent_turn_while_idle_over_5m; other buckets are not", () => {
		const events = [osEvent("presence.idle", T("00"), { bucket: ">5m" }), osEvent("presence.idle", T("30"), { bucket: "<15s" }), ...turn(T("10"), T("20"))];
		assert.deepEqual(computeObservations(events), [{ kind: "agent_turn_while_idle_over_5m", from: T("10"), to: T("20"), label: "observation", refs: [REQ] }]);
		const notIdle = [osEvent("presence.idle", T("00"), { bucket: "1-5m" }), ...turn(T("10"), T("20"))];
		assert.deepEqual(computeObservations(notIdle), []);
	});

	test("a turn that does not overlap makes no observation (touching a boundary is not overlap)", () => {
		const hidden = [osEvent("tab.visibility", T("00"), { state: "hidden" }), osEvent("tab.visibility", T("10"), { state: "visible" })];
		assert.deepEqual(computeObservations([...hidden, ...turn(T("10"), T("20"))]), [], "turn starts as the tab becomes visible");
		assert.deepEqual(computeObservations([...hidden, ...turn(T("20"), T("30"))]), [], "turn after the span");
		assert.deepEqual(computeObservations([...turn(T("00"), T("05")), osEvent("tab.visibility", T("05"), { state: "hidden" })]), [], "turn ends as the tab hides");
		// Positive control for the same events one second later.
		assert.equal(computeObservations([...hidden, ...turn(T("09"), T("20"))]).length, 1);
	});

	test("a turn overlapping two kinds, and an unpaired turn_end, behave as the rule says", () => {
		const both = [osEvent("tab.visibility", T("00"), { state: "hidden" }), osEvent("window.focus", T("02"), { focused: false }), ...turn(T("05"), T("15"))];
		assert.deepEqual(computeObservations(both).map((o) => o.kind).sort(), ["agent_turn_while_blurred", "agent_turn_while_hidden"]);
		const unpaired = [osEvent("tab.visibility", T("00"), { state: "hidden" }), turn(T("05"), T("15"))[1]];
		assert.deepEqual(computeObservations(unpaired), []);
	});

	test("merged observations are labelled 'observation' and the timeline still validates", () => {
		const events = clone(VALID.events);
		// Hide the tab at 09:07:50 and show it at 09:08:02, across the turn 09:07:58..09:08:04.
		const hidden = { v: 1, interviewId: VALID.interviewId, source: "os", seq: 0, type: "tab.visibility", at: "2026-11-22T09:07:50.000Z", data: { state: "hidden" }, clientAt: "2026-11-22T09:07:49.900Z" };
		const visible = { ...hidden, type: "tab.visibility", at: "2026-11-22T09:08:02.000Z", data: { state: "visible" }, clientAt: "2026-11-22T09:08:01.900Z" };
		const os = events.filter((e) => e.source === "os");
		// Renumber os seq in time order after inserting the two events.
		const withNew = [...os, hidden, visible].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
		withNew.forEach((e, i) => { e.seq = i + 1; });
		const ev = evidenceFrom([...events.filter((e) => e.source !== "os"), ...withNew], VALID.identity);
		const merged = mergeEvidence(ev, { now: () => new Date(VALID.generatedAt) });
		assert.deepEqual(merged.observations, [{ kind: "agent_turn_while_hidden", from: "2026-11-22T09:07:58.000Z", to: "2026-11-22T09:08:02.000Z", label: "observation", refs: [REQ] }]);
		assert.deepEqual(validateTimeline(merged), []);
	});

	test("the vectors' valid timeline has no overlap, and computeObservations agrees (observations: [])", () => {
		assert.deepEqual(computeObservations(VALID.events), VALID.observations);
	});
});

// ---------------------------------------------------------------------------
// timeline.md
// ---------------------------------------------------------------------------

describe("timeline.md", () => {
	const withPrompt = (data) => {
		const t = clone(VALID);
		const e = t.events.find((x) => x.type === "prompt.captured");
		Object.assign(e.data, data);
		return t;
	};

	test("shows identity, source counts, cannotBeKnown, observations, a chronological table, and says it is not scored", () => {
		const t = clone(VALID);
		t.observations = [{ kind: "agent_turn_while_hidden", from: "2026-11-22T09:07:58.000Z", to: "2026-11-22T09:08:02.000Z", label: "observation", refs: [REQ] }];
		const md = renderMarkdown(t);
		assert.match(md, /not scored/);
		for (const v of Object.values(VALID.identity)) assert.ok(md.includes(v.replaceAll("|", "\\|")), `identity value ${v}`);
		assert.match(md, /works: 5 events, pushTestRuns 0/);
		assert.match(md, /os: 12 events/);
		assert.match(md, /gateway: 2 events/);
		for (const s of vectors.cannotBeKnown) assert.ok(md.includes(s), s);
		assert.match(md, /observation: agent_turn_while_hidden, 2026-11-22T09:07:58\.000Z to 2026-11-22T09:08:02\.000Z/);
		const rows = md.split("\n").filter((l) => /^\| \d+ \|/.test(l));
		assert.equal(rows.length, 19);
		const ats = rows.map((r) => r.split("|")[2].trim());
		assert.deepEqual(ats, [...ats].sort());
		assert.match(rows[0], /repo\.created/);
		assert.match(renderMarkdown(VALID), /None recorded\./);
	});

	test("a prompt shows byte sizes and at most 200 characters of the last user message, nothing of the response", () => {
		const user = `pipe | <b>bold</b> ${"a".repeat(300)}`;
		const t = withPrompt({
			reqBytes: 5120,
			respBytes: 2048,
			content: { request: { messages: [{ role: "user", content: "FIRST" }, { role: "assistant", content: "ANSWER" }, { role: "user", content: [{ type: "text", text: user }] }] }, response: "RESPONSE-BODY-SECRET" },
		});
		const md = renderMarkdown(t);
		assert.match(md, /request 5120 B, response 2048 B/);
		assert.ok(md.includes("a".repeat(181)) && !md.includes("a".repeat(182)), "19 chars of prefix + 181 a = 200");
		assert.ok(md.includes("\\|") && !md.includes("<b>"), "pipes and markup are escaped");
		assert.ok(!md.includes("FIRST") && !md.includes("ANSWER") && !md.includes("RESPONSE-BODY-SECRET"));
		assert.match(md, /\(first 200 characters\)/);
	});

	test("the 200-character cut counts code points and never splits a surrogate pair", () => {
		const ex = excerpt("😀".repeat(300));
		assert.equal([...ex.text].length, 200);
		assert.equal(ex.cut, true);
		const md = renderMarkdown(withPrompt({ content: { request: { messages: [{ role: "user", content: "😀".repeat(300) }] }, response: "r" } }));
		assert.ok(md.includes("😀".repeat(200)) && !md.includes("😀".repeat(201)));
		assert.doesNotMatch(md, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
		assert.equal(excerpt("short").cut, false);
	});

	test("responses endpoint, purged capture, and a last user message with no text", () => {
		assert.equal(lastUserText("responses", { input: "plain" }), "plain");
		assert.equal(lastUserText("responses", { input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] }), "hello");
		assert.equal(lastUserText("messages", { messages: [{ role: "user", content: [{ type: "tool_result", content: "x" }] }] }), null);
		const purged = renderMarkdown(withPrompt({ purged: true, content: null }));
		assert.match(purged, /purged/);
		assert.doesNotMatch(purged, /Add a test for parse/);
		assert.match(renderMarkdown(VALID), /last user message: "Add a test for parse\(\)"/);
		assert.match(renderMarkdown(withPrompt({ content: { request: { messages: [{ role: "user", content: [{ type: "tool_result", content: "x" }] }] }, response: "r" } })), /last user message: \(no text\)/);
	});
});

// ---------------------------------------------------------------------------
// interview.mjs: stub fetch, stub git
// ---------------------------------------------------------------------------

const WORKS_TOKEN = "SENTINEL-works-qa-token-0a1b2c3d";
const OS_TOKEN = "SENTINEL-os-admin-token-4e5f6a7b";
const COOKIE = "SENTINEL-ai-operator-cookie-8c9d0e1f";
const SEED_TOKEN = "SENTINEL-seed-token-2a3b4c5d";
const SECRETS = [WORKS_TOKEN, OS_TOKEN, COOKIE, SEED_TOKEN];
const ID = VALID.interviewId;
const NOTICE = vectors.notice.sha256;
const ORIGIN = { works: "https://api-staging.ezil.work", os: "https://os-staging.ezil.work", gateway: "https://ai-staging.ezil.work" };
const ENV = { PATH: process.env.PATH, EZIL_WORKS_QA_TOKEN: WORKS_TOKEN, EZIL_OS_ADMIN_TOKEN: OS_TOKEN, EZIL_AI_OPERATOR_COOKIE: COOKIE };
const SEED_REMOTE = "https://git-qa.ezil.work/candidate-a/interview-1121.git";

const OPERATOR_COOKIE = `__Host-ezil-op=${COOKIE}`;

/**
 * The gateway's operator-cookie path, which runs before every /v1/admin/ route, reads included
 * (gateway src/auth/auth0/identity.ts authenticateOperatorRequest and requireOperatorSameOrigin, then
 * admin()): only `__Host-ezil-op`, once, never with Authorization, with same-origin evidence, and a live
 * session. Returns the refusal, or null when the call gets through.
 */
function gatewayOperatorRefusal(headers) {
	const h = new Headers(headers);
	const refuse = (status, code) => ({ status, body: { error: { code } } });
	const cookies = (h.get("cookie") ?? "").split(";").map((s) => s.trim()).filter((s) => s.startsWith("__Host-ezil-op="));
	if (cookies.length > 1) return refuse(401, "invalid_operator_session");
	if (cookies.length === 0) return refuse(401, "unauthorized");
	if (h.has("authorization")) return refuse(400, "mixed_credentials");
	const origin = h.get("origin");
	const site = h.get("sec-fetch-site");
	if ((origin !== null && origin !== ORIGIN.gateway) || !(site === "same-origin" || (site === null && origin === ORIGIN.gateway))) {
		return refuse(403, "operator_origin_required");
	}
	return cookies[0] === OPERATOR_COOKIE ? null : refuse(401, "invalid_operator_session");
}

/**
 * A stub fetch. `routes` maps "METHOD origin/path" to a reply (object or function
 * of the recorded call) or an array of replies consumed in turn (the last repeats).
 * Gateway calls first pass the gateway's operator-cookie rule, as on ai-staging.
 */
function stubFetch(routes) {
	const calls = [];
	const fn = async (url, init = {}) => {
		const u = new URL(url);
		const call = { method: init.method, url, key: `${init.method} ${u.origin}${u.pathname}`, headers: init.headers ?? {}, body: init.body === undefined ? undefined : JSON.parse(init.body), redirect: init.redirect };
		calls.push(call);
		const refusal = u.origin === ORIGIN.gateway ? gatewayOperatorRefusal(call.headers) : null;
		if (refusal) return new Response(JSON.stringify(refusal.body), { status: refusal.status });
		let route = routes[call.key];
		if (Array.isArray(route)) route = route.length > 1 ? route.shift() : route[0];
		if (typeof route === "function") route = route(call);
		if (!route) route = { status: 599, body: { error: { code: "unrouted" } } };
		return new Response(JSON.stringify(route.body ?? null), { status: route.status ?? 200 });
	};
	fn.calls = calls;
	return fn;
}

/** A stub git: records argv and env, answers rev-parse with a fixed sha. */
function stubGit({ failOn } = {}) {
	const calls = [];
	const fn = async (args, { cwd, env }) => {
		calls.push({ args: [...args], env: { ...env }, cwd });
		if (failOn && args[0] === failOn) return { code: 1, stdout: "", stderr: `fatal: remote said no (Authorization: Bearer ${SEED_TOKEN})` };
		return { code: 0, stdout: args[0] === "rev-parse" ? "abcdefabcdefabcdefabcdefabcdefabcdefabcd\n" : "", stderr: "" };
	};
	fn.calls = calls;
	return fn;
}

const worksCreateBody = {
	interviewId: ID, repositoryId: "4211", canonicalURL: VALID.identity.canonicalURL, handle: "candidate-a", name: "interview-1121",
	ownerEzilIdSubject: VALID.identity.ezilIdSubject, worksAccountId: "1187",
	seed: { remote: SEED_REMOTE, token: SEED_TOKEN, expiresAt: "2026-11-22T09:05:00.000Z" },
};
const IDENTITY_CONSENTED = { interviewId: ID, state: "consented", identity: VALID.identity, noticeSha256: NOTICE };

function run(args, { env = ENV, fetch = stubFetch({}), git = stubGit(), sleep = async () => {} } = {}) {
	const stdout = capture();
	const stderr = capture();
	const done = interviewMain(args, { env, fetch, git, sleep, now: () => new Date(VALID.generatedAt), stdout, stderr });
	return done.then((code) => ({ code, stdout: stdout.text(), stderr: stderr.text(), fetch, git }));
}

const template = join(scratch, "template");
mkdirSync(template, { recursive: true });
writeFileSync(join(template, "README.md"), "# Interview\n");
const CREATE_ARGS = ["create", "--candidate-email", "cand@example.com", "--handle", "candidate-a", "--name", "interview-1121", "--title", "Interview 1121", "--template", template, "--idempotency-key", "5f0e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4"];

describe("interview.mjs: environment and usage", () => {
	test("a missing credential exits 64 naming the variable, before any request", async () => {
		const cases = [
			[CREATE_ARGS, "EZIL_WORKS_QA_TOKEN"],
			[CREATE_ARGS, "EZIL_OS_ADMIN_TOKEN"],
			[["start", "--interview", ID], "EZIL_OS_ADMIN_TOKEN"],
			[["start", "--interview", ID], "EZIL_AI_OPERATOR_COOKIE"],
			[["finish", "--interview", ID], "EZIL_AI_OPERATOR_COOKIE"],
			[["finish", "--interview", ID], "EZIL_WORKS_QA_TOKEN"],
			[["export", "--interview", ID, "--out", join(scratch, "x")], "EZIL_WORKS_QA_TOKEN"],
			[["export", "--interview", ID, "--out", join(scratch, "x")], "EZIL_AI_OPERATOR_COOKIE"],
		];
		for (const [args, name] of cases) {
			const env = { ...ENV };
			delete env[name];
			const r = await run(args, { env });
			assert.equal(r.code, 64, `${args[0]} without ${name}`);
			assert.ok(r.stderr.includes(`missing environment variable ${name}`), r.stderr);
			assert.equal(r.fetch.calls.length, 0, "no request was made");
			for (const s of SECRETS) assert.ok(!r.stderr.includes(s) && !r.stdout.includes(s));
		}
		// Positive control: with all three set the same command proceeds to a request.
		const ok = await run(["finish", "--interview", ID]);
		assert.notEqual(ok.code, 64);
		assert.ok(ok.fetch.calls.length > 0);
	});

	test("usage errors exit 64; --help exits 0", async () => {
		assert.equal((await run([])).code, 64);
		assert.equal((await run(["bogus"])).code, 64);
		assert.equal((await run(["start"])).code, 64, "start needs --interview");
		assert.equal((await run(["start", "--interview", "not-a-uuid"])).code, 64);
		assert.equal((await run(["export", "--interview", ID])).code, 64, "export needs --out");
		assert.equal((await run(["finish", "--interview", ID, "--nope"])).code, 64);
		assert.equal((await run(["create", "--handle", "h"])).code, 64);
		const help = await run(["--help"]);
		assert.equal(help.code, 0);
		assert.match(help.stdout, /create .*start .*finish .*export/s);
		assert.ok(["EZIL_WORKS_QA_TOKEN", "EZIL_OS_ADMIN_TOKEN", "EZIL_AI_OPERATOR_COOKIE"].every((n) => help.stdout.includes(n)));
	});
});

describe("interview.mjs create", () => {
	const routes = () => ({
		[`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`]: { status: 201, body: worksCreateBody },
		[`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/seeded`]: { status: 200, body: {} },
		[`POST ${ORIGIN.os}/api/admin/interviews`]: { status: 201, body: { interviewId: ID, state: "registered" } },
	});

	test("Works create, template push with the seed, Works seeded, OS register, then the candidate link", async () => {
		const r = await run(CREATE_ARGS, { fetch: stubFetch(routes()) });
		assert.equal(r.code, 0, r.stderr);
		const order = [...r.fetch.calls.map((c) => c.key)];
		assert.deepEqual(order, [
			`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`,
			`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/seeded`,
			`POST ${ORIGIN.os}/api/admin/interviews`,
		]);
		const [createCall, seededCall, registerCall] = r.fetch.calls;
		assert.deepEqual(createCall.body, { candidateEmail: "cand@example.com", handle: "candidate-a", name: "interview-1121", title: "Interview 1121" });
		assert.equal(createCall.headers["idempotency-key"], "5f0e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4");
		assert.equal(createCall.headers.authorization, `Bearer ${WORKS_TOKEN}`);
		assert.deepEqual(seededCall.body, { headSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd" });
		assert.equal(registerCall.headers.authorization, `Bearer ${OS_TOKEN}`);
		assert.deepEqual(registerCall.body, { interviewId: ID, repositoryId: "4211", canonicalURL: VALID.identity.canonicalURL, handle: "candidate-a", ownerEzilIdSubject: VALID.identity.ezilIdSubject, worksAccountId: "1187" });
		assert.ok(r.fetch.calls.every((c) => c.redirect === "error"), "redirects are never followed with credentials");
		assert.ok(r.fetch.calls.every((c) => Object.values(ORIGIN).some((o) => c.url.startsWith(`${o}/`))), "only the three staging origins");
		const link = `https://os-staging.ezil.work/app/code?repo=${encodeURIComponent(VALID.identity.canonicalURL)}`;
		assert.ok(r.stdout.split("\n").includes(`Candidate link: ${link}`), r.stdout);
		assert.equal(link, "https://os-staging.ezil.work/app/code?repo=https%3A%2F%2Fgit-qa.ezil.work%2Fcandidate-a%2Finterview-1121.git");
	});

	test("the seed token reaches git only through GIT_CONFIG_* env, never argv or the remote URL", async () => {
		const git = stubGit();
		const r = await run(CREATE_ARGS, { fetch: stubFetch(routes()), git });
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(git.calls.map((c) => c.args[0]), ["init", "add", "commit", "rev-parse", "push"]);
		const push = git.calls.at(-1);
		assert.equal(push.args.at(-2), SEED_REMOTE);
		assert.equal(push.args.at(-1), "HEAD:refs/heads/main");
		for (const call of git.calls) {
			assert.ok(!call.args.join(" ").includes(SEED_TOKEN), `argv of git ${call.args[0]}`);
			assert.ok(!JSON.stringify(call.args).includes("Bearer"));
		}
		assert.equal(push.env.GIT_CONFIG_KEY_0, `http.${SEED_REMOTE}.extraHeader`);
		assert.equal(push.env.GIT_CONFIG_VALUE_0, `Authorization: Bearer ${SEED_TOKEN}`);
		assert.equal(push.env.GIT_CONFIG_KEY_1, "http.followRedirects");
		assert.equal(push.env.GIT_TERMINAL_PROMPT, "0");
		for (const [name, value] of Object.entries(push.env)) {
			if (name !== "GIT_CONFIG_VALUE_0") assert.ok(!String(value).includes(SEED_TOKEN), `${name} must not carry the seed token`);
		}
		// Only the push carries it; the other git steps have no header.
		for (const call of git.calls.slice(0, -1)) assert.equal(call.env.GIT_CONFIG_COUNT, undefined);
		// The child gets an explicit environment: none of the three credentials leak into it.
		for (const call of git.calls) for (const value of Object.values(call.env)) {
			for (const s of [WORKS_TOKEN, OS_TOKEN, COOKIE]) assert.ok(!String(value).includes(s));
		}
	});

	test("a failed push stops before seeded and OS register, prints a resume hint, and scrubs the seed token", async () => {
		const r = await run(CREATE_ARGS, { fetch: stubFetch(routes()), git: stubGit({ failOn: "push" }) });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /git push failed: fatal: remote said no/);
		assert.match(r.stderr, /--idempotency-key 5f0e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4/);
		assert.deepEqual(r.fetch.calls.map((c) => c.key), [`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`]);
		assert.ok(!r.stderr.includes(SEED_TOKEN), "the seed token is scrubbed from git's error text");
		assert.match(r.stderr, /Bearer \[redacted\]/);
	});

	test("a Works refusal is reported by status and code only; no git runs", async () => {
		const fetch = stubFetch({ [`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`]: { status: 409, body: { error: { code: "push_tests_enabled", message: `leaked ${WORKS_TOKEN}` } } } });
		const git = stubGit();
		const r = await run(CREATE_ARGS, { fetch, git });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /works create: refused 409 push_tests_enabled/);
		assert.equal(git.calls.length, 0);
		assert.ok(!r.stderr.includes(WORKS_TOKEN) && !r.stdout.includes(WORKS_TOKEN));
	});

	test("a 202 with no seed (still provisioning, erratum E2) stops before any push and says to retry with the same key", async () => {
		const fetch = stubFetch({ [`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`]: { status: 202, body: { ...worksCreateBody, seed: null } } });
		const git = stubGit();
		const r = await run(CREATE_ARGS, { fetch, git });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /still being provisioned \(202, no seed yet\)/);
		assert.match(r.stderr, /--idempotency-key 5f0e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4/);
		assert.doesNotMatch(r.stderr, /unexpected response/);
		assert.equal(git.calls.length, 0);
	});

	test("a seed remote that is not https, or carries credentials, is refused before any push", async () => {
		for (const remote of ["http://git-qa.ezil.work/x.git", `https://user:${SEED_TOKEN}@git-qa.ezil.work/x.git`, "file:///etc"]) {
			const fetch = stubFetch({ ...routes(), [`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`]: { status: 201, body: { ...worksCreateBody, seed: { ...worksCreateBody.seed, remote } } } });
			const git = stubGit();
			const r = await run(CREATE_ARGS, { fetch, git });
			assert.equal(r.code, 1, remote);
			assert.match(r.stderr, /seed remote must be an https URL without credentials/);
			assert.equal(git.calls.length, 0);
		}
	});

	test("real git sends the URL-scoped Authorization header over HTTP, and the token is not in the URL", async () => {
		const seen = [];
		const server = createServer((req, res) => {
			seen.push({ url: req.url, authorization: req.headers.authorization });
			res.writeHead(403).end();
		});
		await new Promise((done) => server.listen(0, "127.0.0.1", done));
		try {
			const remote = `http://127.0.0.1:${server.address().port}/r.git`;
			await assert.rejects(
				pushTemplate({ templateDir: template, remote, token: SEED_TOKEN, pathEnv: process.env.PATH }),
				(err) => /git push failed/.test(err.message),
			);
			assert.ok(seen.length > 0, "git reached the server");
			assert.equal(seen[0].url, "/r.git/info/refs?service=git-receive-pack");
			assert.equal(seen[0].authorization, `Bearer ${SEED_TOKEN}`);
			assert.ok(seen.every((r) => !r.url.includes(SEED_TOKEN)));
		} finally {
			await new Promise((done) => server.close(done));
		}
	});

	test("pushTemplate with real git: same template, same head sha, and a repeat push succeeds", async () => {
		const bare = join(scratch, "bare.git");
		const init = spawnSync("git", ["init", "--bare", "-q", "-b", "main", bare], { encoding: "utf8" });
		assert.equal(init.status, 0, init.stderr);
		const first = await pushTemplate({ templateDir: template, remote: bare, token: SEED_TOKEN, pathEnv: process.env.PATH });
		const second = await pushTemplate({ templateDir: template, remote: bare, token: SEED_TOKEN, pathEnv: process.env.PATH });
		assert.match(first, /^[0-9a-f]{40}$/);
		assert.equal(second, first, "deterministic commit");
		const head = spawnSync("git", ["--git-dir", bare, "rev-parse", "refs/heads/main"], { encoding: "utf8" });
		assert.equal(head.stdout.trim(), first);
		// Positive control: different content gives a different sha.
		const other = join(scratch, "template2");
		mkdirSync(other, { recursive: true });
		writeFileSync(join(other, "README.md"), "# Different\n");
		const bare2 = join(scratch, "bare2.git");
		assert.equal(spawnSync("git", ["init", "--bare", "-q", "-b", "main", bare2], { encoding: "utf8" }).status, 0);
		assert.notEqual(await pushTemplate({ templateDir: other, remote: bare2, token: "t", pathEnv: process.env.PATH }), first);
	});
});

describe("interview.mjs start", () => {
	const consentRoute = { status: 201, body: { consentId: "c1", interviewId: ID, authUserId: VALID.identity.osUserId, grantedAt: "2026-11-22T09:05:30.000Z", retentionDays: 14 } };
	const statusKey = `GET ${ORIGIN.os}/api/admin/interviews/${ID}`;
	const registered = { status: 200, body: { interviewId: ID, state: "registered", identity: { ...VALID.identity, osUserId: null }, noticeSha256: null } };
	const consented = { status: 200, body: IDENTITY_CONSENTED };
	const startRoutes = (statuses) => ({
		[statusKey]: statuses,
		[`POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents`]: consentRoute,
		[`POST ${ORIGIN.os}/api/admin/interviews/${ID}/start`]: { status: 200, body: { state: "started" } },
	});

	test("--wait polls OS until consented, grants the gateway consent for osUserId, then starts", async () => {
		const sleeps = [];
		const fetch = stubFetch(startRoutes([registered, registered, consented]));
		const r = await run(["start", "--interview", ID, "--wait"], { fetch, sleep: async (ms) => { sleeps.push(ms); } });
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(sleeps, [5000, 5000], "polls every 5 s");
		const keys = fetch.calls.map((c) => c.key);
		assert.deepEqual(keys, [statusKey, statusKey, statusKey, `POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents`, `POST ${ORIGIN.os}/api/admin/interviews/${ID}/start`]);
		const consent = fetch.calls[3];
		assert.deepEqual(consent.body, { interviewId: ID, authUserId: VALID.identity.osUserId, noticeSha256: NOTICE, retentionDays: 14, reason: consent.body.reason });
		assert.ok(consent.body.reason.length > 0);
		assert.equal(consent.headers.cookie, OPERATOR_COOKIE);
		assert.equal(consent.headers.origin, ORIGIN.gateway);
		assert.match(consent.headers["idempotency-key"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
		assert.equal(fetch.calls[0].headers.authorization, `Bearer ${OS_TOKEN}`);
	});

	test("without --wait a registered interview is refused and nothing else is called", async () => {
		const fetch = stubFetch(startRoutes([registered]));
		const r = await run(["start", "--interview", ID], { fetch });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /has not accepted the notice yet \(state registered\); rerun with --wait/);
		assert.deepEqual(fetch.calls.map((c) => c.key), [statusKey]);
	});

	test("--wait gives up after --timeout", async () => {
		const sleeps = [];
		const r = await run(["start", "--interview", ID, "--wait", "--timeout", "15", "--interval", "5"], { fetch: stubFetch(startRoutes([registered])), sleep: async (ms) => { sleeps.push(ms); } });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /timed out after 15 s/);
		assert.deepEqual(sleeps, [5000, 5000]);
	});

	test("repeating start on a started interview replays consent and start with the same Idempotency-Key", async () => {
		const started = { status: 200, body: { ...IDENTITY_CONSENTED, state: "started" } };
		const a = stubFetch(startRoutes([started]));
		const b = stubFetch(startRoutes([started]));
		assert.equal((await run(["start", "--interview", ID], { fetch: a })).code, 0);
		assert.equal((await run(["start", "--interview", ID], { fetch: b })).code, 0);
		const key = (f) => f.calls.find((c) => c.method === "POST" && c.url.includes("interview-capture-consents")).headers["idempotency-key"];
		assert.equal(key(a), key(b));
	});

	test("consent_active stops before OS start; a notice other than v1 is refused", async () => {
		const routes = startRoutes([consented]);
		routes[`POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents`] = { status: 409, body: { error: { code: "consent_active" } } };
		const fetch = stubFetch(routes);
		const r = await run(["start", "--interview", ID], { fetch });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /gateway consent: refused 409 consent_active/);
		assert.ok(!fetch.calls.some((c) => c.url.endsWith("/start")));
		const wrong = stubFetch(startRoutes([{ status: 200, body: { ...IDENTITY_CONSENTED, noticeSha256: "0".repeat(64) } }]));
		const w = await run(["start", "--interview", ID], { fetch: wrong });
		assert.equal(w.code, 1);
		assert.match(w.stderr, /not notice v1/);
		assert.equal(wrong.calls.length, 1);
	});

	test("a finished interview is not started", async () => {
		const r = await run(["start", "--interview", ID], { fetch: stubFetch(startRoutes([{ status: 200, body: { ...IDENTITY_CONSENTED, state: "finished" } }])) });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /interview is finished/);
	});
});

describe("interview.mjs finish", () => {
	const osStatus = `GET ${ORIGIN.os}/api/admin/interviews/${ID}`;
	const gatewayEvents = `GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`;
	const worksEvidence = `GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`;
	const preflight = [osStatus, gatewayEvents, worksEvidence];
	const osFinish = `POST ${ORIGIN.os}/api/admin/interviews/${ID}/finish`;
	const revoke = `POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents/${ID}/revoke`;
	const worksFinish = `POST ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/finish`;
	const split = evidenceFrom(VALID.events, VALID.identity);
	const routes = () => ({
		[osStatus]: { status: 200, body: { ...IDENTITY_CONSENTED, state: "started" } },
		[gatewayEvents]: { status: 200, body: split.gateway },
		[worksEvidence]: { status: 200, body: split.works },
		[osFinish]: { status: 200, body: { state: "finished" } },
		[revoke]: { status: 200, body: { revokedAt: "2026-11-22T09:45:01.000Z" } },
		[worksFinish]: { status: 200, body: { frozenAt: "2026-11-22T09:45:02.000Z" } },
	});
	const writes = (fetch) => fetch.calls.filter((c) => c.method !== "GET").map((c) => c.key);

	test("proves all three credentials read-only, then runs OS finish, gateway revoke, Works finish in that order, and is safe to repeat", async () => {
		for (let pass = 1; pass <= 2; pass++) {
			const fetch = stubFetch(routes());
			const r = await run(["finish", "--interview", ID], { fetch });
			assert.equal(r.code, 0, `pass ${pass}: ${r.stderr}`);
			assert.deepEqual(fetch.calls.map((c) => c.key), [...preflight, osFinish, revoke, worksFinish]);
			assert.ok(fetch.calls[4].body.reason.length > 0);
			assert.ok(fetch.calls[4].headers["idempotency-key"]);
			assert.match(r.stdout, /preflight: works, os and gateway credentials accepted/);
			assert.match(r.stdout, /works: repository frozen at 2026-11-22T09:45:02\.000Z/);
		}
	});

	test("no gateway consent (404 not_found) passes the preflight and is not an error; Works finish still runs", async () => {
		const notFound = { status: 404, body: { error: { code: "not_found" } } };
		const r = stubFetch({ ...routes(), [gatewayEvents]: notFound, [revoke]: notFound });
		const out = await run(["finish", "--interview", ID], { fetch: r });
		assert.equal(out.code, 0, out.stderr);
		assert.match(out.stdout, /gateway: no consent to revoke/);
		assert.deepEqual(r.calls.map((c) => c.key), [...preflight, osFinish, revoke, worksFinish]);
	});

	test("review N1: an expired operator session is refused by the preflight, before OS finish or anything else is written", async () => {
		// The stub gateway knows only COOKIE's session, so another value is the 401 an expired session gets.
		const fetch = stubFetch(routes());
		const r = await run(["finish", "--interview", ID], { env: { ...ENV, EZIL_AI_OPERATOR_COOKIE: "__Host-ezil-op=expired-session" }, fetch });
		assert.equal(r.code, 1);
		assert.deepEqual(fetch.calls.map((c) => c.key), preflight, "only the three reads ran");
		assert.deepEqual(writes(fetch), []);
		assert.match(r.stderr, /finish preflight: refused by gateway 401 invalid_operator_session \(EZIL_AI_OPERATOR_COOKIE\); nothing was finished/);
	});

	test("the preflight names every refused credential, not only the first", async () => {
		const expired = { status: 401, body: { error: { code: "unauthorized" } } };
		const fetch = stubFetch({ ...routes(), [osStatus]: expired, [worksEvidence]: expired });
		const r = await run(["finish", "--interview", ID], { env: { ...ENV, EZIL_AI_OPERATOR_COOKIE: "__Host-ezil-op=expired-session" }, fetch });
		assert.equal(r.code, 1);
		assert.deepEqual(writes(fetch), []);
		assert.match(r.stderr, /refused by os 401 unauthorized \(EZIL_OS_ADMIN_TOKEN\), gateway 401 invalid_operator_session \(EZIL_AI_OPERATOR_COOKIE\), works 401 unauthorized \(EZIL_WORKS_QA_TOKEN\)/);
		// A gateway 404 other than not_found is not taken as proof.
		const other = stubFetch({ ...routes(), [gatewayEvents]: { status: 404, body: { error: { code: "route_missing" } } } });
		const o = await run(["finish", "--interview", ID], { fetch: other });
		assert.equal(o.code, 1);
		assert.deepEqual(writes(other), []);
	});

	test("an OS finish failure stops before the revoke and the Works finish", async () => {
		const fetch = stubFetch({ ...routes(), [osFinish]: { status: 409, body: { error: { code: "interview_state" } } } });
		const out = await run(["finish", "--interview", ID], { fetch });
		assert.equal(out.code, 1);
		assert.match(out.stderr, /os finish: refused 409 interview_state/);
		assert.deepEqual(writes(fetch), [osFinish]);
	});

	test("review N1: after OS finish, a refused revoke still freezes Works, and each outcome is reported", async () => {
		// The session expires between the preflight and the revoke.
		const fetch = stubFetch({ ...routes(), [revoke]: { status: 401, body: { error: { code: "invalid_operator_session" } } } });
		const r = await run(["finish", "--interview", ID], { fetch });
		assert.equal(r.code, 1);
		assert.deepEqual(writes(fetch), [osFinish, revoke, worksFinish]);
		assert.match(r.stdout, /os: finished/);
		assert.match(r.stderr, /gateway revoke: refused 401 invalid_operator_session/);
		assert.match(r.stdout, /works: repository frozen at 2026-11-22T09:45:02\.000Z/);
		assert.match(r.stderr, /finish incomplete: gateway revoke failed; every step is idempotent, so rerun finish/);
	});

	test("review N1: a refused Works finish after the revoke is reported too; both failing names both", async () => {
		const unavailable = { status: 503, body: { error: { code: "unavailable" } } };
		const fetch = stubFetch({ ...routes(), [worksFinish]: unavailable });
		const r = await run(["finish", "--interview", ID], { fetch });
		assert.equal(r.code, 1);
		assert.match(r.stdout, /gateway: consent revoked/);
		assert.match(r.stderr, /works finish: refused 503 unavailable/);
		assert.match(r.stderr, /finish incomplete: works finish failed/);
		const both = stubFetch({ ...routes(), [revoke]: unavailable, [worksFinish]: unavailable });
		const b = await run(["finish", "--interview", ID], { fetch: both });
		assert.equal(b.code, 1);
		assert.deepEqual(writes(both), [osFinish, revoke, worksFinish]);
		assert.match(b.stderr, /finish incomplete: gateway revoke and works finish failed/);
	});
});

describe("interview.mjs export", () => {
	const split = evidenceFrom(VALID.events, VALID.identity);
	const exportRoutes = (gateway = { status: 200, body: split.gateway }) => ({
		[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`]: { status: 200, body: split.works },
		[`GET ${ORIGIN.os}/api/admin/interviews/${ID}/events`]: { status: 200, body: split.os },
		[`GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`]: gateway,
	});

	test("writes timeline.json (equal to timeline.valid) and timeline.md, and the file validates", async () => {
		const out = join(scratch, "export-ok");
		const r = await run(["export", "--interview", ID, "--out", out], { fetch: stubFetch(exportRoutes()) });
		assert.equal(r.code, 0, r.stderr);
		assert.deepEqual(readdirSync(out).sort(), ["timeline.json", "timeline.md"]);
		assert.deepEqual(JSON.parse(readFileSync(join(out, "timeline.json"), "utf8")), VALID);
		assert.match(readFileSync(join(out, "timeline.md"), "utf8"), /^# EZiL interview timeline/);
		assert.equal(validateFile(readFileSync(join(out, "timeline.json"), "utf8")).code, 0);
		assert.match(r.stdout, /events: works 5, os 12, gateway 2; pushTestRuns 0/);
	});

	test("a gateway with no consent record exports zero gateway events and says so", async () => {
		const out = join(scratch, "export-nogateway");
		const events = VALID.events.filter((e) => e.source !== "gateway");
		const routes = exportRoutes({ status: 404, body: { error: { code: "not_found" } } });
		routes[`GET ${ORIGIN.os}/api/admin/interviews/${ID}/events`] = { status: 200, body: evidenceFrom(events, VALID.identity).os };
		const r = await run(["export", "--interview", ID, "--out", out], { fetch: stubFetch(routes) });
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stderr, /no consent record for this interview/);
		assert.equal(JSON.parse(readFileSync(join(out, "timeline.json"), "utf8")).sources.gateway.count, 0);
	});

	test("pushTestRuns above 0 is written but the export fails with the validator's message", async () => {
		const out = join(scratch, "export-pushtests");
		const routes = exportRoutes();
		routes[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`] = { status: 200, body: { ...split.works, pushTestRuns: 1 } };
		const r = await run(["export", "--interview", ID, "--out", out], { fetch: stubFetch(routes) });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /pushTestRuns: const: must equal 0 \(got 1\)/);
	});

	test("disagreeing interviewIds refuse the merge and write nothing", async () => {
		const out = join(scratch, "export-mismatch");
		const routes = exportRoutes();
		routes[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`] = { status: 200, body: { ...split.works, interviewId: "11111111-1111-4111-8111-111111111111" } };
		const r = await run(["export", "--interview", ID, "--out", out], { fetch: stubFetch(routes) });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /export: works evidence interviewId/);
		assert.throws(() => readdirSync(out), /ENOENT/);
	});
});

describe("interview.mjs credentials", () => {
	test("no flow prints or writes a planted credential, though the stub echoes them back", async () => {
		const out = join(scratch, "export-secrets");
		const echo = (code) => ({ status: 403, body: { error: { code, message: `${WORKS_TOKEN} ${OS_TOKEN} ${COOKIE} ${SEED_TOKEN}` }, echoed: [WORKS_TOKEN, OS_TOKEN, COOKIE, SEED_TOKEN] } });
		const split = evidenceFrom(VALID.events, VALID.identity);
		const flows = [
			// create, ending in a refusal whose code IS a credential value: it must come out as [redacted].
			[CREATE_ARGS, { [`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`]: echo(WORKS_TOKEN) }],
			// create, full success (the seed token is in the response and in git's env, not in the output).
			[CREATE_ARGS, {
				[`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories`]: { status: 201, body: worksCreateBody },
				[`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/seeded`]: { status: 200, body: {} },
				[`POST ${ORIGIN.os}/api/admin/interviews`]: { status: 201, body: {} },
			}],
			[["start", "--interview", ID], { [`GET ${ORIGIN.os}/api/admin/interviews/${ID}`]: echo(OS_TOKEN) }],
			// finish, past the preflight, ending in a revoke refusal that echoes every credential.
			[["finish", "--interview", ID], {
				[`GET ${ORIGIN.os}/api/admin/interviews/${ID}`]: { status: 200, body: IDENTITY_CONSENTED },
				[`GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`]: { status: 200, body: split.gateway },
				[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`]: { status: 200, body: split.works },
				[`POST ${ORIGIN.os}/api/admin/interviews/${ID}/finish`]: { status: 200, body: {} },
				[`POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents/${ID}/revoke`]: echo(COOKIE),
				[`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/finish`]: echo(WORKS_TOKEN),
			}],
			[["export", "--interview", ID, "--out", out], {
				[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`]: { status: 200, body: split.works },
				[`GET ${ORIGIN.os}/api/admin/interviews/${ID}/events`]: { status: 200, body: split.os },
				[`GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`]: { status: 200, body: split.gateway },
			}],
		];
		let sawRedaction = false;
		for (const [args, routes] of flows) {
			const fetch = stubFetch(routes);
			const git = stubGit();
			const r = await run(args, { fetch, git });
			const text = `${r.stdout}\n${r.stderr}`;
			for (const s of SECRETS) assert.ok(!text.includes(s), `${args[0]} output contains a credential`);
			sawRedaction ||= text.includes("[redacted]");
			// Positive control: the credential really was sent to the server on the first request.
			const first = fetch.calls[0];
			assert.ok(first.headers.authorization === `Bearer ${WORKS_TOKEN}` || first.headers.authorization === `Bearer ${OS_TOKEN}` || first.headers.cookie === OPERATOR_COOKIE, `${args[0]} sent its credential`);
		}
		assert.ok(sawRedaction, "the scrubber actually fired when a credential-valued code was echoed");
		for (const name of readdirSync(out)) {
			const body = readFileSync(join(out, name), "utf8");
			for (const s of SECRETS) assert.ok(!body.includes(s), `${name} contains a credential`);
		}
	});

	test("export refuses to write output that contains a credential value", async () => {
		const out = join(scratch, "export-leak");
		const split = evidenceFrom(VALID.events, VALID.identity);
		const leaky = clone(split.gateway);
		leaky.events.find((e) => e.type === "prompt.captured").data.content.request.messages[0].content = `my cookie is ${COOKIE}`;
		const fetch = stubFetch({
			[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`]: { status: 200, body: split.works },
			[`GET ${ORIGIN.os}/api/admin/interviews/${ID}/events`]: { status: 200, body: split.os },
			[`GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`]: { status: 200, body: leaky },
		});
		const r = await run(["export", "--interview", ID, "--out", out], { fetch });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /refusing to write output that contains a credential value/);
		assert.throws(() => readdirSync(out), /ENOENT/);
	});

	test("the only environment variables the tool reads are the three credentials (and PATH for git)", () => {
		const source = readFileSync(join(TOOLS, "interview.mjs"), "utf8");
		const reads = [...source.matchAll(/(?:process\.env|ctx\.env)(?:\.([A-Z_]+)|\[)/g)].map((m) => m[1] ?? "[dynamic]");
		assert.ok(reads.every((n) => n === "PATH" || n === "[dynamic]"), `env reads: ${reads.join(", ")}`);
		assert.ok(["EZIL_WORKS_QA_TOKEN", "EZIL_OS_ADMIN_TOKEN", "EZIL_AI_OPERATOR_COOKIE"].every((n) => source.includes(n)));
	});
});

describe("interview.mjs: the gateway operator cookie (review B1)", () => {
	const split = evidenceFrom(VALID.events, VALID.identity);
	const flows = [
		[["start", "--interview", ID], {
			[`GET ${ORIGIN.os}/api/admin/interviews/${ID}`]: { status: 200, body: { ...IDENTITY_CONSENTED, state: "started" } },
			[`POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents`]: { status: 200, body: { authUserId: VALID.identity.osUserId } },
			[`POST ${ORIGIN.os}/api/admin/interviews/${ID}/start`]: { status: 200, body: {} },
		}],
		[["finish", "--interview", ID], {
			[`GET ${ORIGIN.os}/api/admin/interviews/${ID}`]: { status: 200, body: { ...IDENTITY_CONSENTED, state: "started" } },
			[`GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`]: { status: 200, body: split.gateway },
			[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`]: { status: 200, body: split.works },
			[`POST ${ORIGIN.os}/api/admin/interviews/${ID}/finish`]: { status: 200, body: {} },
			[`POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents/${ID}/revoke`]: { status: 200, body: { revokedAt: "2026-11-22T09:45:01.000Z" } },
			[`POST ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/finish`]: { status: 200, body: { frozenAt: "2026-11-22T09:45:02.000Z" } },
		}],
		[["export", "--interview", ID, "--out", join(scratch, "export-b1")], {
			[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`]: { status: 200, body: split.works },
			[`GET ${ORIGIN.os}/api/admin/interviews/${ID}/events`]: { status: 200, body: split.os },
			[`GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`]: { status: 200, body: split.gateway },
		}],
	];

	test("the stub applies the gateway's rule: no Origin, another Origin, cross-site, a bare value, mixed or doubled credentials are refused", () => {
		const ok = { cookie: OPERATOR_COOKIE, origin: ORIGIN.gateway };
		assert.equal(gatewayOperatorRefusal(ok), null, "positive control");
		assert.equal(gatewayOperatorRefusal({ cookie: OPERATOR_COOKIE, "sec-fetch-site": "same-origin" }), null);
		const refused = (headers) => gatewayOperatorRefusal(headers)?.body.error.code;
		assert.equal(refused({ cookie: OPERATOR_COOKIE }), "operator_origin_required", "Node fetch sends no Origin by itself");
		assert.equal(refused({ ...ok, origin: ORIGIN.os }), "operator_origin_required");
		assert.equal(refused({ ...ok, "sec-fetch-site": "cross-site" }), "operator_origin_required");
		assert.equal(refused({ cookie: COOKIE, origin: ORIGIN.gateway }), "unauthorized", "a bare value is no operator cookie");
		assert.equal(refused({ ...ok, authorization: `Bearer ${OS_TOKEN}` }), "mixed_credentials");
		assert.equal(refused({ ...ok, cookie: `${OPERATOR_COOKIE}; ${OPERATOR_COOKIE}` }), "invalid_operator_session");
		assert.equal(refused({ ...ok, cookie: "__Host-ezil-op=expired" }), "invalid_operator_session");
	});

	test("either form of EZIL_AI_OPERATOR_COOKIE sends __Host-ezil-op=VALUE with the gateway's Origin on every gateway call", async () => {
		for (const value of [COOKIE, OPERATOR_COOKIE]) {
			for (const [args, routes] of flows) {
				const fetch = stubFetch(routes);
				const r = await run(args, { env: { ...ENV, EZIL_AI_OPERATOR_COOKIE: value }, fetch });
				assert.equal(r.code, 0, `${args[0]} with ${value === COOKIE ? "a bare value" : "the named cookie"}: ${r.stderr}`);
				const gateway = fetch.calls.filter((c) => c.url.startsWith(`${ORIGIN.gateway}/`));
				assert.ok(gateway.length > 0, `${args[0]} called the gateway`);
				for (const c of gateway) {
					assert.equal(c.headers.cookie, OPERATOR_COOKIE);
					assert.equal(c.headers.origin, ORIGIN.gateway);
					assert.equal(c.headers.authorization, undefined);
				}
				for (const c of fetch.calls.filter((c) => !c.url.startsWith(`${ORIGIN.gateway}/`))) {
					assert.equal(c.headers.cookie, undefined, "the operator cookie goes to the gateway only");
					assert.equal(c.headers.origin, undefined);
				}
				for (const s of SECRETS) assert.ok(!r.stdout.includes(s) && !r.stderr.includes(s));
			}
		}
	});

	test("any other form exits 64 naming __Host-ezil-op, before any request, without echoing the value", async () => {
		const bad = [`ezil_session=${COOKIE}`, `${OPERATOR_COOKIE}; other=1`, "__Host-ezil-op=", `${COOKIE} `, `"${COOKIE}"`, `__host-ezil-op=${COOKIE}`, `a=${COOKIE}`];
		for (const value of bad) {
			for (const [args] of flows) {
				const r = await run(args, { env: { ...ENV, EZIL_AI_OPERATOR_COOKIE: value } });
				assert.equal(r.code, 64, `${args[0]} with ${JSON.stringify(value)}`);
				// The message names the cookie (an env value is scrubbed wherever it appears, even inside the message).
				assert.match(r.stderr, /EZIL_AI_OPERATOR_COOKIE must be .* or the bare VALUE of the __Host-ezil-op cookie/);
				assert.equal(r.fetch.calls.length, 0, "no request was made");
				assert.ok(!r.stderr.includes(COOKIE) && !r.stdout.includes(COOKIE), "the value is not echoed");
			}
		}
		// create does not use the gateway, so the cookie's form does not matter to it.
		const create = await run(CREATE_ARGS, { env: { ...ENV, EZIL_AI_OPERATOR_COOKIE: "ezil_session=x" }, fetch: stubFetch({}) });
		assert.notEqual(create.code, 64);
	});

	test("with the named form, an echoed bare session value is scrubbed too", async () => {
		const fetch = stubFetch({
			[`GET ${ORIGIN.os}/api/admin/interviews/${ID}`]: { status: 200, body: IDENTITY_CONSENTED },
			[`POST ${ORIGIN.gateway}/v1/admin/interview-capture-consents`]: { status: 403, body: { error: { code: COOKIE } } },
		});
		const r = await run(["start", "--interview", ID], { env: { ...ENV, EZIL_AI_OPERATOR_COOKIE: OPERATOR_COOKIE }, fetch });
		assert.equal(r.code, 1);
		assert.match(r.stderr, /gateway consent: refused 403 \[redacted\]/);
		assert.ok(!r.stderr.includes(COOKIE));
	});

	test("--help names the cookie and when to renew it", async () => {
		const help = await run(["--help"]);
		assert.match(help.stdout, /EZIL_AI_OPERATOR_COOKIE .*__Host-ezil-op/s);
		assert.match(help.stdout, /sign in again right before finish and export/);
	});
});

describe("git.push refs the schema refuses (review N8, erratum E10)", () => {
	const { schema } = loadContract();
	const PATTERN = new RegExp(schema.$defs["data:git.push"].properties.ref.pattern);
	/** E10's decoding: `..` and two uppercase hex digits is one byte; git never puts `..` in a ref. */
	const unmap = (ref) => {
		const name = ref.slice("refs/heads/".length);
		const bytes = [];
		for (let i = 0; i < name.length;) {
			if (name.startsWith("..", i) && /^[0-9A-F]{2}$/.test(name.slice(i + 2, i + 4))) { bytes.push(parseInt(name.slice(i + 2, i + 4), 16)); i += 4; }
			else bytes.push(name.charCodeAt(i++));
		}
		return `refs/heads/${Buffer.from(bytes).toString("utf8")}`;
	};

	test("a ref inside the pattern is unchanged; one outside is escaped byte by byte, reversibly, into the pattern", () => {
		for (const ref of ["refs/heads/main", "refs/heads/feature/x_y-1.2", `refs/heads/${"a".repeat(240)}`]) assert.equal(mapPushRef(ref, PATTERN), ref);
		const cases = {
			"refs/heads/fix#12": "refs/heads/fix..2312",
			"refs/heads/a+b": "refs/heads/a..2Bb",
			"refs/heads/café": "refs/heads/caf..C3..A9",
			"refs/heads/a.#": "refs/heads/a...23",
			"refs/heads/x@{y}": "refs/heads/x..40..7By..7D",
			"refs/heads/日本": "refs/heads/..E6..97..A5..E6..9C..AC",
		};
		for (const [ref, mapped] of Object.entries(cases)) {
			assert.equal(PATTERN.test(ref), false, `${ref} is outside the pattern`);
			assert.equal(mapPushRef(ref, PATTERN), mapped);
			assert.ok(PATTERN.test(mapped), mapped);
			assert.equal(unmap(mapped), ref, "decodes back");
		}
		assert.equal(new Set(Object.values(cases)).size, Object.keys(cases).length);
	});

	test("a result still outside the pattern (too long) is the sha256 form; other values pass through", () => {
		for (const ref of [`refs/heads/${"a".repeat(241)}`, `refs/heads/${"é".repeat(40)}`]) {
			const mapped = mapPushRef(ref, PATTERN);
			assert.equal(mapped, `refs/heads/..sha256.${createHash("sha256").update(ref, "utf8").digest("hex")}`);
			assert.ok(PATTERN.test(mapped));
		}
		assert.notEqual(mapPushRef(`refs/heads/${"a".repeat(241)}`, PATTERN), mapPushRef(`refs/heads/${"a".repeat(242)}`, PATTERN));
		// Not a branch ref, or not a string: left for validation to report.
		for (const ref of ["refs/tags/v#1", "main", null, 7]) assert.equal(mapPushRef(ref, PATTERN), ref);
	});

	test("export maps Works' pushed refs before validating, so the timeline is valid; the sources are not mutated", async () => {
		const split = evidenceFrom(VALID.events, VALID.identity);
		const works = clone(split.works);
		const push = works.events.find((e) => e.type === "git.push");
		assert.ok(push, "the vector has a git.push");
		push.data.ref = "refs/heads/fix#12";
		const second = { ...clone(push), seq: works.events.length + 1, data: { ...clone(push.data), ref: "refs/heads/café" } };
		works.events.push(second);
		const raw = clone(works);
		// Negative control: the same events unmapped fail the schema.
		const unmapped = clone(VALID);
		unmapped.events.find((e) => e.type === "git.push").data.ref = "refs/heads/fix#12";
		assert.ok(validateTimeline(unmapped).some((line) => /\.ref: pattern/.test(line)));

		const merged = mergeEvidence({ works, os: split.os, gateway: split.gateway }, { now: () => new Date(VALID.generatedAt) });
		assert.deepEqual(works, raw, "the Works response is not mutated");
		assert.deepEqual(merged.events.filter((e) => e.type === "git.push").map((e) => e.data.ref), ["refs/heads/fix..2312", "refs/heads/caf..C3..A9"]);
		assert.deepEqual(validateTimeline(merged), []);

		const out = join(scratch, "export-refs");
		const fetch = stubFetch({
			[`GET ${ORIGIN.works}/v1/ops/qa/interview-repositories/${ID}/evidence`]: { status: 200, body: { ...split.works, events: split.works.events.map((e) => (e.type === "git.push" ? { ...e, data: { ...e.data, ref: "refs/heads/fix#12" } } : e)) } },
			[`GET ${ORIGIN.os}/api/admin/interviews/${ID}/events`]: { status: 200, body: split.os },
			[`GET ${ORIGIN.gateway}/v1/admin/interviews/${ID}/events`]: { status: 200, body: split.gateway },
		});
		const r = await run(["export", "--interview", ID, "--out", out], { fetch });
		assert.equal(r.code, 0, r.stderr);
		assert.match(r.stdout, /timeline valid/);
		const written = readFileSync(join(out, "timeline.json"), "utf8");
		assert.equal(JSON.parse(written).events.find((e) => e.type === "git.push").data.ref, "refs/heads/fix..2312");
		assert.equal(validateFile(written).code, 0, "validate exits 0 on the export");
		assert.match(readFileSync(join(out, "timeline.md"), "utf8"), /refs\/heads\/fix\.\.2312/);
	});
});
