#!/usr/bin/env node
/**
 * The interview timeline: merge the three evidence responses, validate the
 * result, and render it. Evidence only (docs/contracts/interview-evidence-v1.md
 * section 9): nothing here scores, ranks or infers.
 *
 *   node tools/interview-timeline.mjs validate FILE
 *
 * Exit 0 valid, 1 invalid (one error per line on stderr), 64 usage.
 *
 * The schema and the vectors are read from docs/contracts at run time, so the
 * frozen contract stays the single source of the closed type list, the
 * source/type pairing, the notice hash and the four `cannotBeKnown` strings.
 * Where the prose and the vectors disagree the vectors win.
 *
 * The validator implements exactly the JSON Schema subset that file uses and
 * throws on any other keyword, so schema drift cannot silently pass.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONTRACT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "contracts");

export const SOURCES = ["works", "os", "gateway"];
const SOURCE_RANK = { works: 0, os: 1, gateway: 2 };
const AT_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const FIVE_MINUTES_BUCKET = ">5m";
const EXCERPT_CHARS = 200;

let contractCache;
/** The frozen schema and vectors, parsed once. */
export function loadContract() {
	if (!contractCache) {
		const read = (name) => JSON.parse(readFileSync(join(CONTRACT_DIR, name), "utf8"));
		const schema = read("interview-evidence-v1.schema.json");
		const vectors = read("interview-evidence-v1.vectors.json");
		const typeSource = new Map();
		for (const branch of schema.$defs.event.oneOf) {
			typeSource.set(branch.properties.type.const, branch.properties.source.const);
		}
		contractCache = { schema, vectors, typeSource };
	}
	return contractCache;
}

// ---------------------------------------------------------------------------
// JSON Schema subset
// ---------------------------------------------------------------------------

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$defs"]);
const KEYWORDS = new Set([
	"$ref", "oneOf", "if", "then", "else", "const", "enum", "type", "pattern", "minLength",
	"maxLength", "minimum", "maximum", "required", "properties", "additionalProperties",
	"items", "minItems", "maxItems",
]);

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function matchesType(type, v) {
	switch (type) {
		case "string": return typeof v === "string";
		case "integer": return typeof v === "number" && Number.isInteger(v);
		case "number": return typeof v === "number" && Number.isFinite(v);
		case "boolean": return typeof v === "boolean";
		case "null": return v === null;
		case "array": return Array.isArray(v);
		case "object": return isObject(v);
		default: throw new Error(`unsupported schema type ${type}`);
	}
}

function describe(v) {
	if (v === undefined) return "undefined";
	const text = JSON.stringify(v);
	return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

function deepEqual(a, b) {
	if (a === b) return true;
	if (Array.isArray(a)) {
		return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
	}
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
	}
	return false;
}

function resolveRef(root, ref) {
	if (!ref.startsWith("#/")) throw new Error(`unsupported $ref ${ref}`);
	let node = root;
	for (const raw of ref.slice(2).split("/")) {
		const key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
		if (!isObject(node) || !(key in node)) throw new Error(`unresolvable $ref ${ref}`);
		node = node[key];
	}
	return node;
}

const child = (path, key) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`);
const oneLine = (s) => s.replace(/[\r\n\u2028\u2029]+/g, " ");

/**
 * Validate `value` against `schema`. Returns error lines `PATH: KEYWORD: detail`.
 * `hooks` maps a `$ref` string to `(value, path) => string[]`, used to replace
 * the closed 18-way event `oneOf` with a diagnosis that names the rule.
 */
export function validateSchema(schema, root, value, path = "$", hooks = {}) {
	const errors = [];
	const fail = (keyword, detail) => errors.push(oneLine(`${path}: ${keyword}: ${detail}`));
	for (const key of Object.keys(schema)) {
		if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new Error(`unsupported schema keyword ${key}`);
	}
	if (schema.$ref !== undefined) {
		if (hooks[schema.$ref]) errors.push(...hooks[schema.$ref](value, path));
		else errors.push(...validateSchema(resolveRef(root, schema.$ref), root, value, path, hooks));
	}
	if ("const" in schema && !deepEqual(schema.const, value)) {
		fail("const", `must equal ${describe(schema.const)} (got ${describe(value)})`);
	}
	if (schema.enum && !schema.enum.some((e) => deepEqual(e, value))) {
		fail("enum", `must be one of ${schema.enum.map(describe).join(", ")} (got ${describe(value)})`);
	}
	if (schema.type !== undefined) {
		const types = Array.isArray(schema.type) ? schema.type : [schema.type];
		if (!types.some((t) => matchesType(t, value))) {
			fail("type", `must be ${types.join(" or ")} (got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value})`);
		}
	}
	if (typeof value === "string") {
		const length = [...value].length;
		if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
			fail("pattern", `${describe(value)} does not match ${schema.pattern}`);
		}
		if (schema.minLength !== undefined && length < schema.minLength) fail("minLength", `length ${length} < ${schema.minLength}`);
		if (schema.maxLength !== undefined && length > schema.maxLength) fail("maxLength", `length ${length} > ${schema.maxLength}`);
	}
	if (typeof value === "number") {
		if (schema.minimum !== undefined && value < schema.minimum) fail("minimum", `must be >= ${schema.minimum} (got ${value})`);
		if (schema.maximum !== undefined && value > schema.maximum) fail("maximum", `must be <= ${schema.maximum} (got ${value})`);
	}
	if (isObject(value)) {
		for (const key of schema.required ?? []) {
			if (!(key in value)) fail("required", `missing key ${JSON.stringify(key)}`);
		}
		const properties = schema.properties ?? {};
		for (const [key, sub] of Object.entries(properties)) {
			if (key in value) errors.push(...validateSchema(sub, root, value[key], child(path, key), hooks));
		}
		if (schema.additionalProperties === false) {
			for (const key of Object.keys(value)) {
				if (!(key in properties)) fail("additionalProperties", `unexpected key ${JSON.stringify(key)}`);
			}
		} else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
			throw new Error("unsupported additionalProperties schema");
		}
	}
	if (Array.isArray(value)) {
		if (schema.minItems !== undefined && value.length < schema.minItems) fail("minItems", `${value.length} items < ${schema.minItems}`);
		if (schema.maxItems !== undefined && value.length > schema.maxItems) fail("maxItems", `${value.length} items > ${schema.maxItems}`);
		if (schema.items !== undefined) {
			value.forEach((item, i) => errors.push(...validateSchema(schema.items, root, item, `${path}[${i}]`, hooks)));
		}
	}
	if (schema.oneOf) {
		const results = schema.oneOf.map((sub) => validateSchema(sub, root, value, path, hooks));
		const matched = results.filter((r) => r.length === 0).length;
		if (matched === 0) {
			const best = results.reduce((a, b) => (b.length < a.length ? b : a));
			fail("oneOf", `no branch matched (closest: ${best.join("; ")})`);
		} else if (matched > 1) {
			fail("oneOf", `${matched} branches matched, exactly one allowed`);
		}
	}
	if (schema.if !== undefined) {
		const holds = validateSchema(schema.if, root, value, path, hooks).length === 0;
		const branch = holds ? schema.then : schema.else;
		if (branch !== undefined) {
			const label = holds ? "if/then" : "if/else";
			for (const line of validateSchema(branch, root, value, path, hooks)) errors.push(`${line} (${label})`);
		}
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Events and timelines
// ---------------------------------------------------------------------------

/** Validate one envelope. Names the rule: closed-types, source-type-pairing, or the schema keyword. */
export function validateEvent(event, path = "$") {
	const { schema, typeSource } = loadContract();
	if (!isObject(event)) return [`${path}: type: must be object (got ${event === null ? "null" : Array.isArray(event) ? "array" : typeof event})`];
	if (typeof event.type !== "string" || !typeSource.has(event.type)) {
		return [oneLine(`${path}.type: closed-types: unknown event type ${describe(event.type)} (the list of ${typeSource.size} types is closed)`)];
	}
	const expected = typeSource.get(event.type);
	if (typeof event.source === "string" && event.source !== expected && SOURCES.includes(event.source)) {
		return [`${path}.source: source-type-pairing: type ${event.type} belongs to source ${expected}, not ${event.source}`];
	}
	const branch = schema.$defs.event.oneOf.find((b) => b.properties.type.const === event.type);
	return validateSchema(branch, schema, event, path);
}

/** The ordering rule of section 9: (at, works < os < gateway, seq). */
export function compareEvents(a, b) {
	if (a.at !== b.at) return a.at < b.at ? -1 : 1;
	if (a.source !== b.source) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
	return a.seq - b.seq;
}

/** Validate a timeline. Returns one error line per defect; empty means valid. */
export function validateTimeline(timeline) {
	const { schema, vectors } = loadContract();
	const errors = validateSchema(schema.$defs.timeline, schema, timeline, "$", {
		"#/$defs/event": (event, path) => validateEvent(event, path),
	});
	if (!isObject(timeline)) return errors;
	const events = Array.isArray(timeline.events) ? timeline.events : [];
	const typed = events
		.map((event, index) => ({ event, index }))
		.filter(({ event }) => isObject(event));

	// interviewId agreement: top level, identity, every event.
	if (typeof timeline.interviewId === "string") {
		if (isObject(timeline.identity) && timeline.identity.interviewId !== timeline.interviewId) {
			errors.push(oneLine(`$.identity.interviewId: interviewId-agreement: ${describe(timeline.identity.interviewId)} differs from timeline interviewId ${describe(timeline.interviewId)}`));
		}
		for (const { event, index } of typed) {
			if (event.interviewId !== timeline.interviewId) {
				errors.push(oneLine(`$.events[${index}].interviewId: interviewId-agreement: ${describe(event.interviewId)} differs from timeline interviewId ${describe(timeline.interviewId)}`));
			}
		}
	}

	// seq: the set per source is exactly 1..n. Timeline order need not follow seq
	// (a derived agent.turn_start is dated before OS events with a lower seq).
	const counts = { works: 0, os: 0, gateway: 0 };
	for (const source of SOURCES) {
		const ofSource = typed.filter(({ event }) => event.source === source);
		counts[source] = ofSource.length;
		const seen = new Set();
		for (const { event } of ofSource) {
			if (!Number.isInteger(event.seq)) continue;
			if (seen.has(event.seq)) errors.push(`$.events: seq-gapless: source ${source} has seq ${event.seq} more than once`);
			seen.add(event.seq);
		}
		const missing = [];
		for (let n = 1; n <= ofSource.length && missing.length < 5; n++) if (!seen.has(n)) missing.push(n);
		if (missing.length > 0) {
			errors.push(`$.events: seq-gapless: source ${source} has ${ofSource.length} events so seq must be exactly 1..${ofSource.length}; missing ${missing.join(", ")}`);
		}
	}

	// Ordering: strictly increasing by (at, source, seq).
	for (let i = 1; i < events.length; i++) {
		const [a, b] = [events[i - 1], events[i]];
		if (!isObject(a) || !isObject(b)) continue;
		if (!AT_RE.test(a.at) || !AT_RE.test(b.at) || !SOURCES.includes(a.source) || !SOURCES.includes(b.source)) continue;
		if (!Number.isInteger(a.seq) || !Number.isInteger(b.seq)) continue;
		if (compareEvents(a, b) >= 0) {
			errors.push(`$.events[${i}]: ordering: (${b.at}, ${b.source}, ${b.seq}) does not follow (${a.at}, ${a.source}, ${a.seq}); sort by (at, works<os<gateway, seq)`);
		}
	}

	// Source counts must match the events actually present.
	if (isObject(timeline.sources)) {
		for (const source of SOURCES) {
			const declared = timeline.sources[source]?.count;
			if (Number.isInteger(declared) && declared !== counts[source]) {
				errors.push(`$.sources.${source}.count: source-count: declared ${declared} but the timeline has ${counts[source]} ${source} events`);
			}
		}
	}

	// cannotBeKnown is the four fixed strings of the vectors.
	if (Array.isArray(timeline.cannotBeKnown) && !deepEqual(timeline.cannotBeKnown, vectors.cannotBeKnown)) {
		errors.push("$.cannotBeKnown: cannotBeKnown: must be the four fixed strings of the contract vectors, in order");
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

export class MergeError extends Error {}

const BRANCH_PREFIX = "refs/heads/";
const REF_BYTE_OK = /^[A-Za-z0-9._/-]$/;

/**
 * Erratum E10: Works records a pushed branch name as git gave it, and git allows names the schema's
 * `git.push.ref` pattern refuses (`#`, `+`, non-ASCII, over 240 characters). Such a ref, and only such a ref, is
 * mapped into the pattern: each UTF-8 byte of the branch name outside `[A-Za-z0-9._/-]` becomes `..` and its two
 * uppercase hex digits. Git never allows `..` in a ref, so a mapped name cannot equal a pushed one and decodes
 * back. A result still outside the pattern (too long) becomes `refs/heads/..sha256.` and the hex sha256 of the ref.
 */
export function mapPushRef(ref, pattern) {
	if (typeof ref !== "string" || !ref.startsWith(BRANCH_PREFIX) || pattern.test(ref)) return ref;
	let name = "";
	for (const byte of Buffer.from(ref.slice(BRANCH_PREFIX.length), "utf8")) {
		const char = String.fromCharCode(byte);
		name += REF_BYTE_OK.test(char) ? char : `..${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	const mapped = `${BRANCH_PREFIX}${name}`;
	return pattern.test(mapped) ? mapped : `${BRANCH_PREFIX}..sha256.${createHash("sha256").update(ref, "utf8").digest("hex")}`;
}

/**
 * Merge the three evidence responses into a timeline.
 *
 *   works:   section 5   {v, interviewId, pushTestRuns, events}
 *   os:      section 7.3 {v, interviewId, identity, events}
 *   gateway: section 8   {v, interviewId, consent, events}, or null when the
 *            gateway has no consent record for the interview (404)
 *
 * Seq numbers are the sources' own and are never reassigned. A `git.push.ref` the
 * schema refuses is mapped into it (erratum E10, mapPushRef); nothing else changes.
 */
export function mergeEvidence({ works, os, gateway }, { now = () => new Date() } = {}) {
	const { schema, vectors } = loadContract();
	for (const [name, body] of [["works", works], ["os", os]]) {
		if (!isObject(body) || !Array.isArray(body.events)) throw new MergeError(`${name} evidence response has no events array`);
	}
	if (gateway !== null && gateway !== undefined && (!isObject(gateway) || !Array.isArray(gateway.events))) {
		throw new MergeError("gateway evidence response has no events array");
	}
	if (!isObject(os.identity)) throw new MergeError("os evidence response has no identity");
	const ids = { works: works.interviewId, os: os.interviewId };
	if (gateway) ids.gateway = gateway.interviewId;
	for (const [name, id] of Object.entries(ids)) {
		if (id !== os.identity.interviewId) throw new MergeError(`${name} evidence interviewId ${describe(id)} differs from the identity's ${describe(os.identity.interviewId)}`);
	}
	if (gateway?.consent && gateway.consent.authUserId !== os.identity.osUserId) {
		throw new MergeError("gateway consent authUserId differs from the identity's osUserId");
	}
	const refPattern = new RegExp(schema.$defs["data:git.push"].properties.ref.pattern);
	const worksEvents = works.events.map((e) => {
		if (!isObject(e) || e.type !== "git.push" || !isObject(e.data)) return e;
		const ref = mapPushRef(e.data.ref, refPattern);
		return ref === e.data.ref ? e : { ...e, data: { ...e.data, ref } };
	});
	const events = [...worksEvents, ...os.events, ...(gateway?.events ?? [])]
		.sort(compareEvents);
	const count = (source) => events.filter((e) => e.source === source).length;
	return {
		kind: "ezil.interview.timeline.v1",
		v: 1,
		interviewId: os.identity.interviewId,
		identity: os.identity,
		generatedAt: now().toISOString(),
		noticeSha256: vectors.notice.sha256,
		sources: {
			works: { count: count("works"), pushTestRuns: works.pushTestRuns },
			os: { count: count("os") },
			gateway: { count: count("gateway") },
		},
		cannotBeKnown: [...vectors.cannotBeKnown],
		observations: computeObservations(events),
		events,
	};
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

const OBSERVATION_KINDS = ["agent_turn_while_hidden", "agent_turn_while_blurred", "agent_turn_while_idle_over_5m"];

/**
 * Spans during which a state is recorded as true, from the event that began it to
 * the next event that ended it; a span still open at the end of the record runs
 * to +Infinity. `events` must be in timeline order.
 */
function stateSpans(events, type, opens, closes) {
	const spans = [];
	let openAt = null;
	for (const event of events) {
		if (event.source !== "os" || event.type !== type) continue;
		const at = Date.parse(event.at);
		if (opens(event.data) && openAt === null) openAt = at;
		else if (closes(event.data) && openAt !== null) {
			spans.push([openAt, at]);
			openAt = null;
		}
	}
	if (openAt !== null) spans.push([openAt, Infinity]);
	return spans;
}

/**
 * vectors.observationRule: an agent turn [turn_start.at, turn_end.at] (same
 * requestId) that overlaps a hidden tab, a blurred window or presence.idle >5m is
 * an observation, with from/to the overlap. An observation says what was recorded
 * at the same time; it says nothing about attention. Unpaired turn events make no span.
 */
export function computeObservations(rawEvents) {
	const events = [...rawEvents].sort(compareEvents);
	const starts = new Map();
	const turns = [];
	for (const event of events) {
		if (event.source !== "os" || !isObject(event.data)) continue;
		if (event.type === "agent.turn_start") starts.set(event.data.requestId, Date.parse(event.at));
		if (event.type === "agent.turn_end" && starts.has(event.data.requestId)) {
			turns.push({ requestId: event.data.requestId, from: starts.get(event.data.requestId), to: Date.parse(event.at) });
		}
	}
	const spansByKind = {
		agent_turn_while_hidden: stateSpans(events, "tab.visibility", (d) => d.state === "hidden", (d) => d.state === "visible"),
		agent_turn_while_blurred: stateSpans(events, "window.focus", (d) => d.focused === false, (d) => d.focused === true),
		agent_turn_while_idle_over_5m: stateSpans(events, "presence.idle", (d) => d.bucket === FIVE_MINUTES_BUCKET, (d) => d.bucket !== FIVE_MINUTES_BUCKET),
	};
	const found = [];
	for (const turn of turns) {
		for (const kind of OBSERVATION_KINDS) {
			for (const [spanFrom, spanTo] of spansByKind[kind]) {
				const from = Math.max(turn.from, spanFrom);
				const to = Math.min(turn.to, spanTo);
				// Half-open overlap; a zero-length turn counts when it falls inside the span.
				const overlaps = turn.from === turn.to ? spanFrom <= turn.from && turn.from < spanTo : from < to;
				if (overlaps) {
					found.push({ kind, from: new Date(from).toISOString(), to: new Date(to).toISOString(), label: "observation", refs: [turn.requestId] });
				}
			}
		}
	}
	return found.sort((a, b) =>
		a.from < b.from ? -1 : a.from > b.from ? 1
			: a.to < b.to ? -1 : a.to > b.to ? 1
				: OBSERVATION_KINDS.indexOf(a.kind) - OBSERVATION_KINDS.indexOf(b.kind)
					|| (a.refs[0] < b.refs[0] ? -1 : a.refs[0] > b.refs[0] ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

/** Untrusted text into a table cell: no markup, no pipes, one line. */
function cell(text) {
	return String(text)
		.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
		.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
		.replace(/[\\`|*_~[\]]/g, (c) => `\\${c}`);
}

function textOf(content, blockType) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return null;
	const parts = content.filter((b) => isObject(b) && b.type === blockType && typeof b.text === "string").map((b) => b.text);
	return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * The last user message of a captured request, as text, or null. Messages API:
 * `request.messages` with string or `text` blocks. Responses API: `request.input`
 * as a string or items with `input_text` content.
 */
export function lastUserText(endpoint, request) {
	if (!isObject(request)) return null;
	if (endpoint === "messages" && Array.isArray(request.messages)) {
		const last = [...request.messages].reverse().find((m) => isObject(m) && m.role === "user");
		return last ? textOf(last.content, "text") : null;
	}
	if (endpoint === "responses") {
		if (typeof request.input === "string") return request.input;
		if (Array.isArray(request.input)) {
			const last = [...request.input].reverse().find((m) => isObject(m) && m.role === "user");
			return last ? textOf(last.content, "input_text") : null;
		}
	}
	return null;
}

/** At most 200 characters (code points), never splitting a surrogate pair. */
export function excerpt(text) {
	const chars = [...text];
	return { text: chars.slice(0, EXCERPT_CHARS).join(""), cut: chars.length > EXCERPT_CHARS };
}

function summary(event) {
	const d = event.data;
	const short = (sha) => String(sha).slice(0, 8);
	switch (event.type) {
		case "repo.created": return `${d.handle}/${d.name} (repository ${d.repositoryId})`;
		case "repo.seeded": return `head ${short(d.headSha)}`;
		case "git.grant_issued": return `${d.scope} grant (${d.reason}), expires ${d.expiresAt}, presence-gated`;
		case "git.push": return `${d.ref} ${short(d.before)}..${short(d.after)}, ${d.commits.length} commit(s)${d.truncated ? " (truncated)" : ""}`;
		case "consent.accepted": return `notice v${d.noticeVersion}`;
		case "computer.opened": return `computer ${d.computerId}`;
		case "tab.visibility": return `tab ${d.state}`;
		case "window.focus": return d.focused ? "window focused" : "window blurred";
		case "app.focus": return `app ${d.app}`;
		case "presence.idle": return `bucket ${d.bucket}`;
		case "agent.turn_start": return `request ${d.requestId} (derived)`;
		case "agent.turn_end": return `request ${d.requestId}, ${d.modelAlias}, ${d.outcome}, ${d.durationMs} ms, tools read ${d.toolCalls.read} search ${d.toolCalls.search} write ${d.toolCalls.write} other ${d.toolCalls.other}`;
		case "model.request": return `request ${d.requestId}, ${d.modelAlias}, ${d.outcome}, tokens in ${d.tokens.input ?? "-"} out ${d.tokens.output ?? "-"}, total ${d.totalMs ?? "-"} ms`;
		case "prompt.captured": {
			const sizes = `request ${d.reqBytes} B, response ${d.respBytes} B${d.truncated ? ", truncated" : ""}`;
			if (d.purged || !d.content) return `${d.endpoint}, ${sizes}, purged`;
			const text = lastUserText(d.endpoint, d.content.request);
			if (text === null) return `${d.endpoint}, ${sizes}, last user message: (no text)`;
			const ex = excerpt(text);
			return `${d.endpoint}, ${sizes}, last user message: "${ex.text}"${ex.cut ? ` (first ${EXCERPT_CHARS} characters)` : ""}`;
		}
		default: return "";
	}
}

/** timeline.md: identity, counts, cannotBeKnown, observations, and the chronological table. */
export function renderMarkdown(timeline) {
	const id = timeline.identity;
	const lines = [
		"# EZiL interview timeline",
		"",
		"This record is not scored. It lists what the sources recorded, in time order; no attention or cheating judgement is made from it.",
		"",
		"## Identity",
		"",
		`- interviewId: ${cell(id.interviewId)}`,
		`- repositoryId: ${cell(id.repositoryId)}`,
		`- canonicalURL: ${cell(id.canonicalURL)}`,
		`- osUserId: ${cell(id.osUserId ?? "null (notice not accepted)")}`,
		`- ezilIdSubject: ${cell(id.ezilIdSubject)}`,
		`- worksAccountId: ${cell(id.worksAccountId)}`,
		`- noticeSha256: ${timeline.noticeSha256}`,
		`- generatedAt: ${timeline.generatedAt}`,
		"",
		"## Source counts",
		"",
		`- works: ${timeline.sources.works.count} events, pushTestRuns ${timeline.sources.works.pushTestRuns}`,
		`- os: ${timeline.sources.os.count} events`,
		`- gateway: ${timeline.sources.gateway.count} events`,
		"",
		"## What cannot be known",
		"",
		...timeline.cannotBeKnown.map((s) => `- ${cell(s)}`),
		"",
		"## Observations",
		"",
		"An observation is an agent turn that overlapped a recorded hidden tab, blurred window or presence.idle over 5 minutes. It states what overlapped, nothing more.",
		"",
		...(timeline.observations.length === 0
			? ["None recorded."]
			: timeline.observations.map((o) => `- observation: ${o.kind}, ${o.from} to ${o.to}, request ${o.refs.join(", ")}`)),
		"",
		"## Timeline",
		"",
		"| # | at (UTC) | source | seq | type | detail |",
		"|---|---|---|---|---|---|",
		...timeline.events.map((e, i) => `| ${i + 1} | ${e.at} | ${e.source} | ${e.seq} | ${e.type} | ${cell(summary(e))} |`),
		"",
	];
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Usage: node tools/interview-timeline.mjs validate FILE

Validate an ezil.interview.timeline.v1 file against the frozen contract
(docs/contracts/interview-evidence-v1.*): schema, closed types, source/type
pairing, gapless seq per source, ordering, interviewId agreement, source counts
and pushTestRuns === 0.

Exit 0 valid, 1 invalid (one error per line on stderr), 64 usage.
`;

export function main(argv, { stdout = process.stdout, stderr = process.stderr, read = (f) => readFileSync(f, "utf8") } = {}) {
	if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
		stdout.write(USAGE);
		return 0;
	}
	if (argv.length !== 2 || argv[0] !== "validate") {
		stderr.write(USAGE);
		return 64;
	}
	let parsed;
	try {
		parsed = JSON.parse(read(argv[1]));
	} catch (err) {
		stderr.write(`${argv[1]}: ${oneLine(err instanceof Error ? err.message : String(err))}\n`);
		return 1;
	}
	const errors = validateTimeline(parsed);
	if (errors.length > 0) {
		stderr.write(`${errors.join("\n")}\n`);
		return 1;
	}
	stdout.write(`valid: ${parsed.events.length} events, interview ${parsed.interviewId}\n`);
	return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = main(process.argv.slice(2));
}
