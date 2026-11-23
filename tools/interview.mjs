#!/usr/bin/env node
/**
 * The founder's interview CLI (docs/contracts/interview-evidence-v1.md sections
 * 5, 7.3, 8 and 9). Evidence only: it creates, starts, finishes and exports an
 * interview; it scores nothing and infers nothing.
 *
 *   node tools/interview.mjs create --candidate-email E --handle H --name N --title T --template DIR
 *   node tools/interview.mjs start --interview ID [--wait]
 *   node tools/interview.mjs finish --interview ID
 *   node tools/interview.mjs export --interview ID --out DIR
 *
 * Credentials come from three environment variables and nowhere else:
 * EZIL_WORKS_QA_TOKEN, EZIL_OS_ADMIN_TOKEN and EZIL_AI_OPERATOR_COOKIE (the gateway's
 * `__Host-ezil-op` operator session, sent with the gateway's own Origin). Their
 * values, and the Works seed token, are never printed, logged or written: every
 * line this tool emits is scrubbed of them, and the exported files are refused if
 * they contain one. Only the three staging origins below are ever contacted, so a
 * credential cannot be sent elsewhere; there is no base-URL option.
 *
 * Exit 0 done, 1 refused or failed, 64 usage or a missing environment variable.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContract, MergeError, mergeEvidence, renderMarkdown, validateSchema, validateTimeline } from "./interview-timeline.mjs";

const ORIGINS = {
	works: "https://api-staging.ezil.work",
	os: "https://os-staging.ezil.work",
	gateway: "https://ai-staging.ezil.work",
};
const WORKS_BASE = "/v1/ops/qa/interview-repositories";
/** The only cookie the gateway's operator path reads (gateway src/auth/auth0/identity.ts). */
const OPERATOR_COOKIE = "__Host-ezil-op";
/** RFC 6265 cookie-octets: no whitespace, quote, comma, semicolon or backslash. */
const COOKIE_VALUE_RE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;
const CREDENTIAL_ENV = {
	works: "EZIL_WORKS_QA_TOKEN",
	os: "EZIL_OS_ADMIN_TOKEN",
	gateway: "EZIL_AI_OPERATOR_COOKIE",
};
/** Which credentials each command needs, in the order a missing one is reported. */
const NEEDS = {
	create: ["works", "os"],
	start: ["os", "gateway"],
	finish: ["os", "gateway", "works"],
	export: ["works", "os", "gateway"],
};
const OPTIONS = {
	create: { values: ["candidate-email", "handle", "name", "title", "template", "idempotency-key"], flags: [] },
	start: { values: ["interview", "timeout", "interval"], flags: ["wait"] },
	finish: { values: ["interview"], flags: [] },
	export: { values: ["interview", "out"], flags: [] },
};
const RETENTION_DAYS = 14;
const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_SECONDS = 5;
const DEFAULT_WAIT_SECONDS = 3600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const USAGE = `Usage:
  node tools/interview.mjs create --candidate-email EMAIL --handle HANDLE --name NAME --title TITLE --template DIR [--idempotency-key UUID]
  node tools/interview.mjs start --interview ID [--wait] [--timeout SECONDS] [--interval SECONDS]
  node tools/interview.mjs finish --interview ID
  node tools/interview.mjs export --interview ID --out DIR

Environment (names only; values are never printed):
  EZIL_WORKS_QA_TOKEN       create, finish, export
  EZIL_OS_ADMIN_TOKEN       create, start, finish, export
  EZIL_AI_OPERATOR_COOKIE   start, finish, export: the ${OPERATOR_COOKIE} cookie of an ai-staging operator
                            sign-in, as ${OPERATOR_COOKIE}=VALUE or the bare VALUE. It lasts 1 h and does
                            not renew: sign in again right before finish and export.

Staging only. Exit 0 done, 1 refused or failed, 64 usage or missing environment variable.
`;

class UsageError extends Error {}
class StepError extends Error {}

// ---------------------------------------------------------------------------
// Output, scrubbed of every credential value
// ---------------------------------------------------------------------------

function makeIo(ctx) {
	const secrets = new Set(Object.values(CREDENTIAL_ENV).map((name) => ctx.env[name]).filter((v) => typeof v === "string" && v.length > 0));
	const session = operatorSession(ctx.env);
	if (session !== null) secrets.add(session);
	const redact = (text) => {
		let out = String(text);
		for (const secret of secrets) out = out.split(secret).join("[redacted]");
		return out;
	};
	return {
		secrets,
		redact,
		say: (line) => ctx.stdout.write(`${redact(line)}\n`),
		warn: (line) => ctx.stderr.write(`${redact(line)}\n`),
	};
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * The operator session value of EZIL_AI_OPERATOR_COOKIE, given as `__Host-ezil-op=VALUE` or as the bare VALUE;
 * null for anything else (another cookie name, several cookies, whitespace), which the gateway would refuse.
 */
function operatorSession(env) {
	const raw = env[CREDENTIAL_ENV.gateway];
	if (typeof raw !== "string") return null;
	const value = raw.startsWith(`${OPERATOR_COOKIE}=`) ? raw.slice(OPERATOR_COOKIE.length + 1) : raw.includes("=") ? null : raw;
	return value !== null && COOKIE_VALUE_RE.test(value) ? value : null;
}

/**
 * One place that knows each service's credential header. The gateway's operator cookie path also needs
 * same-origin evidence on every route, reads included (requireOperatorSameOrigin), so its own Origin is sent.
 */
function authHeaders(service, env) {
	if (service === "gateway") return { cookie: `${OPERATOR_COOKIE}=${operatorSession(env)}`, origin: ORIGINS.gateway };
	return { authorization: `Bearer ${env[CREDENTIAL_ENV[service]]}` };
}

/** Only the error code ever leaves a refusal; a response body is never echoed. */
function refusalCode(body) {
	const raw = body?.error?.code ?? (typeof body?.error === "string" ? body.error : body?.code);
	return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : "unknown";
}

async function call(ctx, service, method, path, { body, headers } = {}) {
	let res;
	try {
		res = await ctx.fetch(`${ORIGINS[service]}${path}`, {
			method,
			redirect: "error",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			headers: {
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...authHeaders(service, ctx.env),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	} catch (err) {
		throw new StepError(`${service} ${method} ${path}: request failed (${err instanceof Error ? err.name : "error"})`);
	}
	let parsed = null;
	try {
		parsed = JSON.parse(await res.text());
	} catch {
		// A non-JSON body is treated as no body.
	}
	return { status: res.status, body: parsed, ok: res.status >= 200 && res.status < 300 };
}

/** The body of a 2xx response, or a StepError naming the status and refusal code. */
function accept(label, res) {
	if (!res.ok) throw new StepError(`${label}: refused ${res.status} ${refusalCode(res.body)}`);
	return res.body;
}

/** A stable UUID for a write's Idempotency-Key, so repeating a command replays it. */
function keyFor(label) {
	const h = createHash("sha256").update(label).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// Template push
// ---------------------------------------------------------------------------

function runGit(args, { cwd, env }) {
	return new Promise((resolveRun) => {
		const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => { stdout += d; });
		child.stderr.on("data", (d) => { stderr += d; });
		child.on("error", (err) => resolveRun({ code: 127, stdout, stderr: `${stderr}${err.message}` }));
		child.on("close", (code) => resolveRun({ code: code ?? 1, stdout, stderr }));
	});
}

/** Regular files of `dir`, relative paths; symlinks are refused and `.git` skipped. */
function templateFiles(dir, rel = "") {
	const files = [];
	for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const path = join(rel, entry.name);
		if (lstatSync(join(dir, path)).isSymbolicLink()) throw new UsageError(`template contains a symlink: ${path}`);
		if (entry.isDirectory()) files.push(...templateFiles(dir, path));
		else if (entry.isFile()) files.push(path);
	}
	return files;
}

/**
 * Commit `templateDir` into a fresh repository and push it to `remote` as main.
 * The seed token travels only in the child's environment as a URL-scoped
 * `http.extraHeader` (GIT_CONFIG_*): never in argv, never in the remote URL. The
 * commit identity and dates are fixed, so the same template always yields the same
 * head sha and a repeated create pushes nothing new. Returns the head sha.
 */
export async function pushTemplate({ templateDir, remote, token, git = runGit, pathEnv = "/usr/bin:/bin" }) {
	const files = templateFiles(templateDir);
	if (files.length === 0) throw new UsageError("template directory has no files");
	const work = mkdtempSync(join(tmpdir(), "ezil-interview-template-"));
	try {
		for (const file of files) {
			mkdirSync(dirname(join(work, file)), { recursive: true });
			copyFileSync(join(templateDir, file), join(work, file));
		}
		const identity = { name: "EZiL interview", email: "interview@ezil.work", date: "2000-01-01T00:00:00Z" };
		const base = {
			PATH: pathEnv,
			LANG: "C",
			HOME: work,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_TERMINAL_PROMPT: "0",
			GIT_AUTHOR_NAME: identity.name,
			GIT_AUTHOR_EMAIL: identity.email,
			GIT_AUTHOR_DATE: identity.date,
			GIT_COMMITTER_NAME: identity.name,
			GIT_COMMITTER_EMAIL: identity.email,
			GIT_COMMITTER_DATE: identity.date,
		};
		const step = async (args, env = {}) => {
			const result = await git(args, { cwd: work, env: { ...base, ...env } });
			if (result.code !== 0) throw new StepError(`git ${args[0]} failed: ${String(result.stderr).trim().slice(0, 300)}`);
			return result.stdout;
		};
		await step(["init", "-q", "-b", "main"]);
		await step(["add", "-A"]);
		await step(["commit", "-q", "--no-verify", "--no-gpg-sign", "-m", "Interview template"]);
		const headSha = (await step(["rev-parse", "HEAD"])).trim();
		await step(["push", "-q", remote, "HEAD:refs/heads/main"], {
			GIT_CONFIG_COUNT: "2",
			GIT_CONFIG_KEY_0: `http.${remote}.extraHeader`,
			GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
			GIT_CONFIG_KEY_1: "http.followRedirects",
			GIT_CONFIG_VALUE_1: "false",
		});
		return headSha;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const CREATE_RESPONSE = {
	type: "object",
	required: ["interviewId", "repositoryId", "canonicalURL", "handle", "name", "ownerEzilIdSubject", "worksAccountId", "seed"],
	properties: {
		interviewId: { $ref: "#/$defs/uuid" },
		repositoryId: { $ref: "#/$defs/bigint" },
		canonicalURL: { $ref: "#/$defs/canonicalURL" },
		handle: { type: "string", minLength: 1 },
		name: { type: "string", minLength: 1 },
		ownerEzilIdSubject: { type: "string", minLength: 1, maxLength: 255 },
		worksAccountId: { $ref: "#/$defs/bigint" },
		seed: {
			type: "object",
			required: ["remote", "token", "expiresAt"],
			properties: { remote: { type: "string", minLength: 1 }, token: { type: "string", minLength: 1 }, expiresAt: { type: "string" } },
		},
	},
};

async function create(ctx, io, opts) {
	for (const name of ["candidate-email", "handle", "name", "title", "template"]) {
		if (!opts[name]) throw new UsageError(`create needs --${name}`);
	}
	if (!/^[^\s@]+@[^\s@]+$/.test(opts["candidate-email"])) throw new UsageError("--candidate-email is not an email address");
	const templateDir = resolve(opts.template);
	let isDir = false;
	try { isDir = statSync(templateDir).isDirectory(); } catch { /* reported below */ }
	if (!isDir) throw new UsageError("--template is not a directory");
	const key = opts["idempotency-key"] ?? randomUUID();
	if (!UUID_RE.test(key)) throw new UsageError("--idempotency-key must be a UUID");
	const { schema } = loadContract();
	const resume = `resume by rerunning create with the same arguments and --idempotency-key ${key}`;
	try {
		const res = await call(ctx, "works", "POST", WORKS_BASE, {
			headers: { "idempotency-key": key },
			body: { candidateEmail: opts["candidate-email"], handle: opts.handle, name: opts.name, title: opts.title },
		});
		const body = accept("works create", res);
		// Contract erratum E2: 202 with seed null means the repository is still being provisioned; the same
		// Idempotency-Key retries it (the resume line below says how). It is not a malformed answer.
		if (res.status === 202 && body?.seed === null) {
			throw new StepError("works create: the repository is still being provisioned (202, no seed yet)");
		}
		const bad = validateSchema(CREATE_RESPONSE, schema, body);
		if (bad.length > 0) throw new StepError(`works create: unexpected response (${bad[0]})`);
		io.secrets.add(body.seed.token);
		let remote;
		try { remote = new URL(body.seed.remote); } catch { remote = null; }
		if (!remote || remote.protocol !== "https:" || remote.username || remote.password) {
			throw new StepError("works create: seed remote must be an https URL without credentials");
		}
		io.say(`works: ${res.status === 200 ? "replayed" : "created"} interview ${body.interviewId}, repository ${body.repositoryId}`);

		const headSha = await pushTemplate({ templateDir, remote: body.seed.remote, token: body.seed.token, git: ctx.git, pathEnv: ctx.env.PATH });
		io.say(`git: template pushed, head ${headSha}`);
		accept("works seeded", await call(ctx, "works", "POST", `${WORKS_BASE}/${body.interviewId}/seeded`, { body: { headSha } }));
		io.say("works: seeded recorded");
		const registered = await call(ctx, "os", "POST", "/api/admin/interviews", {
			body: {
				interviewId: body.interviewId,
				repositoryId: body.repositoryId,
				canonicalURL: body.canonicalURL,
				handle: body.handle,
				ownerEzilIdSubject: body.ownerEzilIdSubject,
				worksAccountId: body.worksAccountId,
			},
		});
		accept("os register", registered);
		io.say(`os: registered (${registered.status === 200 ? "already registered" : "new"})`);
		io.say(`interviewId: ${body.interviewId}`);
		io.say(`canonicalURL: ${body.canonicalURL}`);
		io.say(`Candidate link: ${ORIGINS.os}/app/code?repo=${encodeURIComponent(body.canonicalURL)}`);
		return 0;
	} catch (err) {
		if (err instanceof StepError) io.warn(resume);
		throw err;
	}
}

async function start(ctx, io, opts) {
	const id = interviewIdOf(opts);
	const interval = numberOpt(opts, "interval", DEFAULT_POLL_SECONDS);
	const timeout = numberOpt(opts, "timeout", DEFAULT_WAIT_SECONDS);
	const { vectors } = loadContract();
	const maxPolls = Math.max(1, Math.ceil(timeout / interval));
	let interview;
	let lastState = null;
	for (let poll = 1; ; poll++) {
		interview = accept("os status", await call(ctx, "os", "GET", `/api/admin/interviews/${id}`));
		if (interview?.state !== lastState) io.say(`os: interview ${id} is ${interview?.state}`);
		lastState = interview?.state;
		if (interview?.state === "consented" || interview?.state === "started") break;
		if (interview?.state === "finished") throw new StepError("interview is finished; nothing to start");
		if (interview?.state !== "registered") throw new StepError(`os status: unexpected state ${JSON.stringify(interview?.state)}`);
		if (!opts.wait) throw new StepError("the candidate has not accepted the notice yet (state registered); rerun with --wait");
		if (poll >= maxPolls) throw new StepError(`timed out after ${timeout} s waiting for the candidate to accept the notice`);
		await ctx.sleep(interval * 1000);
	}
	const osUserId = interview.identity?.osUserId;
	if (typeof osUserId !== "string" || !UUID_RE.test(osUserId)) throw new StepError("os status: identity.osUserId is not a UUID");
	if (interview.noticeSha256 !== undefined && interview.noticeSha256 !== null && interview.noticeSha256 !== vectors.notice.sha256) {
		throw new StepError("os status: the accepted notice is not notice v1");
	}
	const consent = accept("gateway consent", await call(ctx, "gateway", "POST", "/v1/admin/interview-capture-consents", {
		headers: { "idempotency-key": keyFor(`interview-capture-consent:${id}`) },
		body: {
			interviewId: id,
			authUserId: osUserId,
			noticeSha256: vectors.notice.sha256,
			retentionDays: RETENTION_DAYS,
			reason: "RUN-1121 interview recording consent",
		},
	}));
	io.say(`gateway: consent recorded for ${consent?.authUserId ?? osUserId} (${RETENTION_DAYS} days)`);
	accept("os start", await call(ctx, "os", "POST", `/api/admin/interviews/${id}/start`));
	io.say(`os: interview ${id} started`);
	return 0;
}

/**
 * Read-only proof that all three credentials work before finish writes anything, so an expired one (the
 * gateway operator session lasts 1 h and does not renew) cannot leave OS finished with capture still active
 * and the repository still writable. Every refusal is reported, not only the first.
 */
async function finishPreflight(ctx, io, id) {
	const probes = [
		["os", `/api/admin/interviews/${id}`, (res) => res.ok],
		// The gateway route revoke shares admin() with; a 404 not_found (no consent, or the gate off) comes after
		// the operator session is accepted (erratum E6), so it proves the cookie too.
		["gateway", `/v1/admin/interviews/${id}/events`, (res) => res.ok || (res.status === 404 && refusalCode(res.body) === "not_found")],
		["works", `${WORKS_BASE}/${id}/evidence`, (res) => res.ok],
	];
	const refused = [];
	for (const [service, path, accepted] of probes) {
		const res = await call(ctx, service, "GET", path);
		if (!accepted(res)) refused.push(`${service} ${res.status} ${refusalCode(res.body)} (${CREDENTIAL_ENV[service]})`);
	}
	if (refused.length > 0) {
		throw new StepError(`finish preflight: refused by ${refused.join(", ")}; nothing was finished. Renew the named credentials and rerun finish`);
	}
	io.say("preflight: works, os and gateway credentials accepted");
}

async function finish(ctx, io, opts) {
	const id = interviewIdOf(opts);
	await finishPreflight(ctx, io, id);
	accept("os finish", await call(ctx, "os", "POST", `/api/admin/interviews/${id}/finish`));
	io.say("os: finished");
	// After OS finish, the revoke and the Works freeze are each attempted whatever the other answers.
	const failed = [];
	const attempt = async (label, step) => {
		try {
			await step();
		} catch (err) {
			if (!(err instanceof StepError)) throw err;
			io.warn(err.message);
			failed.push(label);
		}
	};
	await attempt("gateway revoke", async () => {
		const revoke = await call(ctx, "gateway", "POST", `/v1/admin/interview-capture-consents/${id}/revoke`, {
			headers: { "idempotency-key": keyFor(`interview-capture-revoke:${id}`) },
			body: { reason: "RUN-1121 interview finished" },
		});
		if (revoke.status === 404 && refusalCode(revoke.body) === "not_found") io.say("gateway: no consent to revoke");
		else {
			accept("gateway revoke", revoke);
			io.say("gateway: consent revoked");
		}
	});
	await attempt("works finish", async () => {
		const frozen = accept("works finish", await call(ctx, "works", "POST", `${WORKS_BASE}/${id}/finish`));
		io.say(`works: repository frozen${typeof frozen?.frozenAt === "string" ? ` at ${frozen.frozenAt}` : ""}`);
	});
	if (failed.length > 0) throw new StepError(`finish incomplete: ${failed.join(" and ")} failed; every step is idempotent, so rerun finish`);
	return 0;
}

async function exportTimeline(ctx, io, opts) {
	const id = interviewIdOf(opts);
	if (!opts.out) throw new UsageError("export needs --out DIR");
	const works = accept("works evidence", await call(ctx, "works", "GET", `${WORKS_BASE}/${id}/evidence`));
	const os = accept("os events", await call(ctx, "os", "GET", `/api/admin/interviews/${id}/events`));
	const gatewayRes = await call(ctx, "gateway", "GET", `/v1/admin/interviews/${id}/events`);
	let gateway = null;
	if (gatewayRes.status === 404 && refusalCode(gatewayRes.body) === "not_found") io.warn("gateway: no consent record for this interview; recording 0 gateway events");
	else {
		gateway = accept("gateway events", gatewayRes);
		// The gateway streams this answer; a stream that ended early reads as no body. Only a 404 means no record.
		if (gateway === null || typeof gateway !== "object") throw new StepError("gateway events: the answer is not complete JSON (the stream ended early?); rerun export");
	}
	let timeline;
	try {
		timeline = mergeEvidence({ works, os, gateway }, { now: ctx.now });
	} catch (err) {
		if (err instanceof MergeError) throw new StepError(`export: ${err.message}`);
		throw err;
	}
	const json = `${JSON.stringify(timeline, null, 2)}\n`;
	const markdown = renderMarkdown(timeline);
	for (const secret of io.secrets) {
		if (json.includes(secret) || markdown.includes(secret)) throw new StepError("export: refusing to write output that contains a credential value");
	}
	const out = resolve(opts.out);
	mkdirSync(out, { recursive: true });
	writeFileSync(join(out, "timeline.json"), json);
	writeFileSync(join(out, "timeline.md"), markdown);
	const counts = timeline.sources;
	io.say(`wrote ${join(out, "timeline.json")} and ${join(out, "timeline.md")}`);
	io.say(`events: works ${counts.works.count}, os ${counts.os.count}, gateway ${counts.gateway.count}; pushTestRuns ${counts.works.pushTestRuns}; observations ${timeline.observations.length}`);
	const errors = validateTimeline(timeline);
	if (errors.length > 0) {
		io.warn(`the exported timeline is not valid (${errors.length} errors):`);
		for (const line of errors) io.warn(line);
		return 1;
	}
	io.say("timeline valid");
	return 0;
}

// ---------------------------------------------------------------------------
// Arguments and entry point
// ---------------------------------------------------------------------------

function parseArgs(command, args) {
	const spec = OPTIONS[command];
	const opts = {};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
		const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
		if (spec.flags.includes(name) && inline === undefined) opts[name] = true;
		else if (spec.values.includes(name)) {
			const value = inline ?? args[++i];
			if (value === undefined || (inline === undefined && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
			opts[name] = value;
		} else throw new UsageError(`unknown option --${name} for ${command}`);
	}
	return opts;
}

function interviewIdOf(opts) {
	if (!opts.interview) throw new UsageError("this command needs --interview ID");
	if (!UUID_RE.test(opts.interview)) throw new UsageError("--interview must be a lowercase UUID");
	return opts.interview;
}

function numberOpt(opts, name, fallback) {
	if (opts[name] === undefined) return fallback;
	const n = Number(opts[name]);
	if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a positive number of seconds`);
	return n;
}

const COMMANDS = { create, start, finish, export: exportTimeline };

/** Run the CLI. Everything outside the process is injected, so tests use a stub fetch and git. */
export async function main(argv, overrides = {}) {
	const ctx = {
		env: process.env,
		fetch: globalThis.fetch,
		git: runGit,
		sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
		now: () => new Date(),
		stdout: process.stdout,
		stderr: process.stderr,
		...overrides,
	};
	const io = makeIo(ctx);
	const [command, ...rest] = argv;
	if (command === "--help" || command === "-h" || (Object.hasOwn(COMMANDS, command ?? "") && rest.includes("--help"))) {
		ctx.stdout.write(USAGE);
		return 0;
	}
	try {
		if (!Object.hasOwn(COMMANDS, command ?? "")) throw new UsageError(command ? `unknown command ${JSON.stringify(command)}` : "a command is required");
		const opts = parseArgs(command, rest);
		for (const service of NEEDS[command]) {
			const name = CREDENTIAL_ENV[service];
			if (!ctx.env[name]) throw new UsageError(`missing environment variable ${name}`);
		}
		if (NEEDS[command].includes("gateway") && operatorSession(ctx.env) === null) {
			throw new UsageError(`${CREDENTIAL_ENV.gateway} must be ${OPERATOR_COOKIE}=VALUE or the bare VALUE of the ${OPERATOR_COOKIE} cookie`);
		}
		return await COMMANDS[command](ctx, io, opts);
	} catch (err) {
		if (err instanceof UsageError) {
			io.warn(`${err.message}\n\n${USAGE.trimEnd()}`);
			return 64;
		}
		io.warn(err instanceof StepError ? err.message : `unexpected error: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main(process.argv.slice(2));
}
