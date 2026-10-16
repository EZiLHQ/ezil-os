#!/usr/bin/env bun

export const CLASSES = ["lost", "same_process", "resumed_checkpoint", "recreated_shell"] as const;
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

/** File survival is decided before process survival; inode changes are evidence of restoration. */
export function classify(before: Json, after: Json, options: Options = {}): Result {
	const diffs = differences(before, after);
	const changed = (...path: string[]) => at(before, ...path) !== at(after, ...path);
	let lost = changed("config", "bashrc", "sha256") || changed("config", "settings", "sha256") ||
		changed("project", "HEAD") ||
		(at(before, "config", "bash_history", "marker_present") === true &&
			at(after, "config", "bash_history", "marker_present") !== true);
	for (const name of keys(at(before, "tools", "commands"), at(after, "tools", "commands"))) {
		for (const field of ["path", "realpath", "sha256"]) {
			lost ||= changed("tools", "commands", name, field);
		}
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
	else if (sameBoot && samePidNs && sameProcess(at(before, "processes", "shell"), at(after, "processes", "shell")) &&
		(!sentinelGiven || sameSentinel)) classification = "same_process";
	else if (options.providerTransition && sameSentinel) classification = "resumed_checkpoint";
	else classification = "recreated_shell";
	const expected = options.expected ?? null;
	return { classification, expected, pass: expected === null || classification === expected, diffs };
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
