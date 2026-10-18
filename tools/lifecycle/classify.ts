#!/usr/bin/env bun

export const CLASSES = ["lost", "insufficient_evidence", "same_process", "resumed_checkpoint", "recreated_shell"] as const;
export type Classification = (typeof CLASSES)[number];
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = { [key: string]: Json };

export interface Diff {
	readonly path: string;
	readonly before: Json;
	readonly after: Json;
}

export interface Options {
	readonly expected?: Classification;
	readonly providerTransition?: boolean;
}

export interface Result {
	readonly classification: Classification;
	readonly expected: Classification | null;
	readonly pass: boolean;
	readonly diffs: readonly Diff[];
	readonly missingEvidence: readonly string[];
}

function object(value: Json | undefined): RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function at(value: Json, ...keys: string[]): Json {
	for (const key of keys) value = object(value)[key] ?? null;
	return value;
}

function keys(before: Json, after: Json): string[] {
	return [...new Set([...Object.keys(object(before)), ...Object.keys(object(after))])].sort();
}

function differences(before: Json, after: Json, path = ""): Diff[] {
	if (before === after) return [];
	const isObject = (value: Json) => value !== null && typeof value === "object" && !Array.isArray(value);
	if (isObject(before) || isObject(after)) {
		return keys(before, after).flatMap((key) => differences(at(before, key), at(after, key), path ? `${path}.${key}` : key));
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		return Array.from({ length: Math.max(before.length, after.length) }, (_, i) =>
			differences(before[i] ?? null, after[i] ?? null, `${path}[${i}]`),
		).flat();
	}
	return [{ path, before, after }];
}

function sameProcess(before: Json, after: Json): boolean {
	const pid = at(before, "pid");
	const starttime = at(before, "starttime");
	return (typeof pid === "number" && Number.isInteger(pid) && pid > 0) &&
		(typeof starttime === "string" && /^\d+$/.test(starttime)) &&
		pid === at(after, "pid") && starttime === at(after, "starttime");
}

function missingEvidence(snapshot: Json, side: string): string[] {
	const missing: string[] = [];
	const need = (valid: boolean, ...path: string[]) => { if (!valid) missing.push(`${side}.${path.join(".")}`); };
	const text = (...path: string[]) => {
		const value = at(snapshot, ...path);
		need(typeof value === "string" && value.trim().length > 0, ...path);
	};
	const hash = (...path: string[]) => {
		const value = at(snapshot, ...path);
		need(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), ...path);
	};
	need(["aws", "cloudflare"].includes(String(at(snapshot, "identity", "provider"))), "identity", "provider");
	text("identity", "boot_id");
	text("identity", "pid_namespace");
	need(sameProcess(at(snapshot, "processes", "shell"), at(snapshot, "processes", "shell")), "processes", "shell");
	for (const field of ["bashrc", "settings"]) hash("config", field, "sha256");
	hash("config", "bash_history", "sha256");
	const historyLines = at(snapshot, "config", "bash_history", "lines");
	need(typeof historyLines === "number" && Number.isInteger(historyLines) && historyLines > 0, "config", "bash_history", "lines");
	need(at(snapshot, "config", "bash_history", "marker_present") === true, "config", "bash_history", "marker_present");
	text("tools", "npm_prefix");
	text("tools", "PATH");
	const commands = Object.keys(object(at(snapshot, "tools", "commands")));
	need(commands.includes("opencode"), "tools", "commands", "opencode");
	for (const name of commands) {
		for (const field of ["path", "realpath", "version"]) text("tools", "commands", name, field);
		hash("tools", "commands", name, "sha256");
	}
	text("project", "path");
	text("project", "HEAD");
	const files = Object.keys(object(at(snapshot, "project", "files")));
	need(files.length > 0, "project", "files");
	for (const file of files) hash("project", "files", file);
	return missing;
}

/** File survival is decided before process survival; inode changes are evidence of restoration. */
export function classify(before: Json, after: Json, options: Options = {}): Result {
	const diffs = differences(before, after);
	const missing = [...missingEvidence(before, "before"), ...missingEvidence(after, "after")];
	const changed = (...path: string[]) => at(before, ...path) !== at(after, ...path);
	let lost = changed("config", "bashrc", "sha256") || changed("config", "settings", "sha256") ||
		changed("project", "HEAD") ||
		(at(before, "config", "bash_history", "marker_present") === true &&
			at(after, "config", "bash_history", "marker_present") !== true);
	lost ||= !options.providerTransition && changed("identity", "provider") &&
		at(before, "identity", "provider") !== null && at(after, "identity", "provider") !== null;
	const beforeLines = at(before, "config", "bash_history", "lines");
	const afterLines = at(after, "config", "bash_history", "lines");
	if (typeof beforeLines === "number" && typeof afterLines === "number") {
		lost ||= afterLines < beforeLines || (afterLines === beforeLines && changed("config", "bash_history", "sha256"));
	}
	for (const name of keys(at(before, "tools", "commands"), at(after, "tools", "commands"))) {
		for (const field of ["path", "realpath", "sha256"]) {
			lost ||= changed("tools", "commands", name, field);
		}
		// A tool that answered --version before and no longer answers is lost, even with the same
		// bytes (a runtime dependency or its environment went away). A changed version string is not.
		lost ||= at(before, "tools", "commands", name, "version") !== null && at(after, "tools", "commands", name, "version") === null;
	}
	for (const name of keys(at(before, "project", "files"), at(after, "project", "files"))) {
		lost ||= changed("project", "files", name);
	}
	const bootId = at(before, "identity", "boot_id");
	const sameBoot = typeof bootId === "string" && bootId.length > 0 && bootId === at(after, "identity", "boot_id");
	// boot_id is the host kernel's: containers on one host share it, so the pid namespace must match too.
	const pidNs = at(before, "identity", "pid_namespace");
	const samePidNs = typeof pidNs === "string" && pidNs.length > 0 && pidNs === at(after, "identity", "pid_namespace");
	const sentinelBefore = at(before, "processes", "sentinel");
	const sentinelAfter = at(after, "processes", "sentinel");
	const sentinelGiven = at(before, "processes", "sentinel_requested") === true ||
		at(after, "processes", "sentinel_requested") === true || sentinelBefore !== null || sentinelAfter !== null;
	const sameSentinel = sameProcess(sentinelBefore, sentinelAfter);
	let classification: Classification;
	if (lost) classification = "lost";
	else if (missing.length > 0) classification = "insufficient_evidence";
	else if (sameBoot && samePidNs && sameProcess(at(before, "processes", "shell"), at(after, "processes", "shell")) &&
		(!sentinelGiven || sameSentinel)) classification = "same_process";
	else if (options.providerTransition && changed("identity", "provider") && samePidNs && sameSentinel) classification = "resumed_checkpoint";
	else classification = "recreated_shell";
	const expected = options.expected ?? null;
	return { classification, expected,
		pass: classification !== "insufficient_evidence" && (expected === null ? classification !== "lost" : classification === expected),
		diffs, missingEvidence: missing };
}

export function parseArgs(args: readonly string[]): { beforePath: string; afterPath: string; options: Options } {
	const [beforePath, afterPath, ...flags] = args;
	if (!beforePath || !afterPath || beforePath.startsWith("--") || afterPath.startsWith("--")) {
		throw new Error("Usage: bun tools/lifecycle/classify.ts before.json after.json [--expect <class>] [--provider-transition]");
	}
	let expected: Classification | undefined;
	let providerTransition = false;
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		if (flag === "--provider-transition") providerTransition = true;
		else if (flag === "--expect") {
			const value = flags[++i];
			if (!CLASSES.includes(value as Classification)) throw new Error(`--expect must be one of: ${CLASSES.join(", ")}`);
			expected = value as Classification;
		} else throw new Error(`Unknown argument: ${flag}`);
	}
	return { beforePath, afterPath, options: { expected, providerTransition } };
}

if (import.meta.main) {
	try {
		const { beforePath, afterPath, options } = parseArgs(Bun.argv.slice(2));
		const [before, after] = await Promise.all([Bun.file(beforePath).json(), Bun.file(afterPath).json()]);
		for (const snapshot of [before, after]) {
			if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
				throw new Error("Snapshots must be JSON objects");
			}
		}
		const result = classify(before, after, options);
		console.log(JSON.stringify(result));
		process.exitCode = result.pass ? 0 : 1;
	} catch (error) {
		console.error(error instanceof Error ? error.message : "Unable to read snapshots");
		process.exitCode = 1;
	}
}
