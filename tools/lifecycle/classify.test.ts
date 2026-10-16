import { describe, expect, it } from "bun:test";

import { classify, parseArgs } from "./classify.ts";

function snapshot() {
	return {
		identity: { provider: "aws", boot_id: "boot-1", pid_namespace: "pid:[4026532001]", hostname: "staging" },
		processes: {
			shell: { pid: 100, starttime: "1000", comm: "bash" },
			sentinel_requested: true,
			sentinel: { pid: 101, starttime: "1001", comm: "sleep" },
			tmux_server: [{ pid: 90, starttime: "900", comm: "tmux: server" }],
			pty_host: [{ pid: 80, starttime: "800", comm: "node" }],
		},
		tools: {
			npm_prefix: "/usr/local",
			PATH: "/usr/local/bin:/usr/bin",
			commands: {
				opencode: {
					path: "/usr/local/bin/opencode", realpath: "/usr/local/lib/opencode",
					sha256: "a".repeat(64), version: "1.0", stat: { inode: "10", links: "1", size: "100" },
				},
			},
		},
		config: {
			bashrc: { sha256: "b".repeat(64) }, settings: { sha256: "c".repeat(64) },
			bash_history: { sha256: "d".repeat(64), lines: 10, marker_present: true },
		},
		project: { path: "/workspace/project", HEAD: "commit-1", files: { "package.json": "e".repeat(64) } },
	};
}

describe("lifecycle classification", () => {
	it("recognizes the same shell and sentinel on the same boot", () => {
		expect(classify(snapshot(), snapshot())).toEqual({ classification: "same_process", expected: null, pass: true, diffs: [], missingEvidence: [] });
	});

	it("accepts the same shell when no sentinel was requested", () => {
		const { sentinel, sentinel_requested, ...processes } = snapshot().processes;
		const before = { ...snapshot(), processes };
		expect(classify(before, structuredClone(before)).classification).toBe("same_process");
	});

	it("recognizes a recreated shell even when the tmux server survived", () => {
		const after = snapshot();
		after.processes.shell.pid = 200;
		expect(classify(snapshot(), after).classification).toBe("recreated_shell");
	});

	it("treats a matching pid and starttime in another pid namespace on the same host as a recreated shell", () => {
		const after = snapshot();
		after.identity.pid_namespace = "pid:[4026532999]";
		expect(classify(snapshot(), after).classification).toBe("recreated_shell");
	});

	it("detects PID reuse through a different shell starttime", () => {
		const after = snapshot();
		after.processes.shell.starttime = "2000";
		expect(classify(snapshot(), after).classification).toBe("recreated_shell");
	});

	it("detects a changed sentinel even if the shell survived", () => {
		const after = snapshot();
		after.processes.sentinel.starttime = "2001";
		expect(classify(snapshot(), after).classification).toBe("recreated_shell");
	});

	it("detects a boot change without trusting reused process identities", () => {
		const after = snapshot();
		after.identity.boot_id = "boot-2";
		expect(classify(snapshot(), after).classification).toBe("recreated_shell");
	});

	it("recognizes a provider checkpoint when the sentinel survived across boots", () => {
		const after = snapshot();
		after.identity.provider = "cloudflare";
		after.identity.boot_id = "boot-2";
		after.processes.shell.pid = 200;
		expect(classify(snapshot(), after, { providerTransition: true }).classification).toBe("resumed_checkpoint");
	});

	it("recognizes a provider checkpoint with a changed shell on the same boot", () => {
		const after = snapshot();
		after.identity.provider = "cloudflare";
		after.processes.shell.pid = 200;
		expect(classify(snapshot(), after, { providerTransition: true }).classification).toBe("resumed_checkpoint");
	});

	it("does not call a same-provider recreation a checkpoint even when requested", () => {
		const after = snapshot();
		after.identity.boot_id = "boot-2";
		after.processes.shell.pid = 200;
		const result = classify(snapshot(), after, { providerTransition: true, expected: "resumed_checkpoint" });
		expect(result.classification).toBe("recreated_shell");
		expect(result.pass).toBe(false);
	});

	it("gives same_process precedence over the provider flag", () => {
		expect(classify(snapshot(), snapshot(), { providerTransition: true }).classification).toBe("same_process");
	});

	it("does not infer checkpoint survival from missing sentinels", () => {
		const before = { ...snapshot(), processes: { shell: snapshot().processes.shell } };
		const after = { ...before, identity: { ...snapshot().identity, boot_id: "boot-2" } };
		expect(classify(before, after, { providerTransition: true }).classification).toBe("recreated_shell");
	});

	it("does not equate null shell and boot identities with survival", () => {
		const missing = { identity: { boot_id: null }, processes: { shell: null, sentinel: null } };
		expect(classify(missing, missing).classification).toBe("insufficient_evidence");
		expect(classify({}, {}).classification).toBe("insufficient_evidence");
	});

	it("does not equate two null sentinels when one was requested", () => {
		const missing = { ...snapshot(), processes: { ...snapshot().processes, sentinel: null } };
		expect(classify(missing, missing).classification).toBe("recreated_shell");
	});

	it("detects a missing shell and a missing sentinel independently", () => {
		for (const field of ["shell", "sentinel"]) {
			const after = { ...snapshot(), processes: { ...snapshot().processes, [field]: null } };
			expect(classify(snapshot(), after).classification).toBe(field === "shell" ? "insufficient_evidence" : "recreated_shell");
		}
	});

	it("fails incomplete baselines even if both snapshots are identically incomplete", () => {
		const incomplete = [
			{},
			{ ...snapshot(), identity: { ...snapshot().identity, provider: null } },
			{ ...snapshot(), config: { ...snapshot().config, settings: { sha256: null } } },
			{ ...snapshot(), config: { ...snapshot().config, bashrc: { sha256: "not-a-sha256" } } },
			{ ...snapshot(), config: { ...snapshot().config, bash_history: { marker_present: false } } },
			{ ...snapshot(), tools: { ...snapshot().tools, commands: {} } },
			{ ...snapshot(), tools: { ...snapshot().tools, commands: { opencode: { path: null, realpath: null, sha256: null, version: null } } } },
			{ ...snapshot(), tools: { ...snapshot().tools, commands: { opencode: { ...snapshot().tools.commands.opencode, version: "" } } } },
			{ ...snapshot(), project: { ...snapshot().project, files: { "package.json": null } } },
		];
		for (const missing of incomplete) {
			const result = classify(missing, structuredClone(missing), { expected: "recreated_shell" });
			expect(result.classification).toBe("insufficient_evidence");
			expect(result.pass).toBe(false);
			expect(result.missingEvidence.length).toBeGreaterThan(0);
		}
	});

	it("does not make missing evidence pass by expecting that classification", () => {
		expect(classify({}, {}, { expected: "insufficient_evidence" }).pass).toBe(false);
	});

	it("reports data loss as a failed acceptance without an expectation", () => {
		const after = snapshot();
		after.tools.commands.opencode.sha256 = "0".repeat(64);
		expect(classify(snapshot(), after).pass).toBe(false);
		expect(classify(snapshot(), after, { expected: "lost" }).pass).toBe(true);
	});

	it("does not use PTY or tmux changes as evidence of shell death", () => {
		const after = snapshot();
		after.processes.pty_host[0]!.pid = 300;
		after.processes.tmux_server[0]!.pid = 301;
		const result = classify(snapshot(), after);
		expect(result.classification).toBe("same_process");
		expect(result.diffs.map((diff) => diff.path)).toContain("processes.pty_host[0].pid");
	});

	it("detects tool command path, resolved path and hash changes", () => {
		for (const field of ["path", "realpath", "sha256"] as const) {
			const after = snapshot();
			after.tools.commands.opencode[field] = "changed";
			expect(classify(snapshot(), after).classification).toBe("lost");
		}
	});

	it("detects tool fields becoming null or missing", () => {
		for (const value of [null, {}]) {
			const after = { ...snapshot(), tools: { commands: { opencode: value } } };
			expect(classify(snapshot(), after).classification).toBe("lost");
		}
	});

	it("detects a removed tool and a changed tool set", () => {
		const withoutTools = { ...snapshot(), tools: { commands: {} } };
		expect(classify(snapshot(), withoutTools).classification).toBe("lost");
		expect(classify(withoutTools, snapshot()).classification).toBe("lost");
	});

	it("records inode-only restoration without declaring loss", () => {
		const after = snapshot();
		after.tools.commands.opencode.stat.inode = "20";
		const result = classify(snapshot(), after);
		expect(result.classification).toBe("same_process");
		expect(result.diffs).toEqual([{ path: "tools.commands.opencode.stat.inode", before: "10", after: "20" }]);
		after.processes.shell.pid = 200;
		expect(classify(snapshot(), after).classification).toBe("recreated_shell");
	});

	it("records tool version and PATH changes without declaring loss", () => {
		const after = snapshot();
		after.tools.commands.opencode.version = "2.0";
		after.tools.PATH = "/usr/bin";
		expect(classify(snapshot(), after).classification).toBe("same_process");
	});

	it("detects changed or missing bashrc and settings hashes", () => {
		for (const field of ["bashrc", "settings"] as const) {
			const changed = snapshot();
			changed.config[field].sha256 = "changed";
			expect(classify(snapshot(), changed).classification).toBe("lost");
			const missing = { ...snapshot(), config: { ...snapshot().config, [field]: { sha256: null } } };
			expect(classify(snapshot(), missing).classification).toBe("lost");
		}
	});

	it("detects project HEAD and file hash changes", () => {
		const changedHead = snapshot();
		changedHead.project.HEAD = "commit-2";
		expect(classify(snapshot(), changedHead).classification).toBe("lost");
		const changedFile = snapshot();
		changedFile.project.files["package.json"] = "changed";
		expect(classify(snapshot(), changedFile).classification).toBe("lost");
	});

	it("detects a null project and a missing tracked project file", () => {
		expect(classify(snapshot(), { ...snapshot(), project: null }).classification).toBe("lost");
		const missing = { ...snapshot(), project: { ...snapshot().project, files: {} } };
		expect(classify(snapshot(), missing).classification).toBe("lost");
	});

	it("detects history marker loss, including an unreadable history", () => {
		for (const value of [false, null]) {
			const after = { ...snapshot(), config: { ...snapshot().config, bash_history: { marker_present: value } } };
			expect(classify(snapshot(), after).classification).toBe("lost");
		}
	});

	it("permits history growth when the marker remains", () => {
		const after = snapshot();
		after.config.bash_history.sha256 = "f".repeat(64);
		after.config.bash_history.lines = 11;
		expect(classify(snapshot(), after).classification).toBe("same_process");
	});

	it("rejects history truncation or same-length replacement even if the marker remains", () => {
		for (const lines of [1, 10]) {
			const after = snapshot();
			after.config.bash_history.lines = lines;
			after.config.bash_history.sha256 = "0".repeat(64);
			expect(classify(snapshot(), after).classification).toBe("lost");
		}
	});

	it("rejects an unexpected provider swap", () => {
		const after = snapshot();
		after.identity.provider = "cloudflare";
		expect(classify(snapshot(), after).classification).toBe("lost");
		expect(classify(snapshot(), after, { providerTransition: true }).classification).toBe("same_process");
	});

	it("does not accept missing or null persistence evidence", () => {
		const minimal = { identity: snapshot().identity, processes: { shell: snapshot().processes.shell } };
		const withNulls = { ...minimal, project: null, config: { settings: { sha256: null } }, tools: { commands: { missing: null } } };
		expect(classify(minimal, withNulls)).toMatchObject({ classification: "insufficient_evidence", expected: null, pass: false, diffs: [] });
	});

	it("gives file loss precedence over checkpoint and process survival", () => {
		const after = snapshot();
		after.config.settings.sha256 = "changed";
		expect(classify(snapshot(), after, { providerTransition: true }).classification).toBe("lost");
		after.identity.boot_id = "boot-2";
		expect(classify(snapshot(), after, { providerTransition: true }).classification).toBe("lost");
	});

	it("reports expected matches and mismatches", () => {
		expect(classify(snapshot(), snapshot(), { expected: "same_process" }).pass).toBe(true);
		const result = classify(snapshot(), snapshot(), { expected: "lost" });
		expect(result.expected).toBe("lost");
		expect(result.pass).toBe(false);
	});
});

describe("CLI", () => {
	it("parses both options in either order", () => {
		for (const flags of [["--expect", "lost", "--provider-transition"], ["--provider-transition", "--expect", "lost"]]) {
			expect(parseArgs(["before.json", "after.json", ...flags])).toEqual({
				beforePath: "before.json", afterPath: "after.json", options: { expected: "lost", providerTransition: true },
			});
		}
	});

	it("rejects missing paths, invalid expectations and unknown options", () => {
		for (const args of [[], ["before.json"], ["before.json", "after.json", "--expect"],
			["before.json", "after.json", "--expect", "unknown"], ["before.json", "after.json", "--unknown"]]) {
			expect(() => parseArgs(args)).toThrow();
		}
	});

	it("prints JSON and exits according to --expect using read-only JSON fixtures", () => {
		const fixture = `${import.meta.dir}/../package.json`;
		for (const [flags, exitCode, pass] of [[[], 1, false], [["--expect", "recreated_shell"], 1, false], [["--expect", "same_process"], 1, false]] as const) {
			const child = Bun.spawnSync([process.execPath, `${import.meta.dir}/classify.ts`, fixture, fixture, ...flags]);
			expect(child.exitCode).toBe(exitCode);
			expect(child.stderr.toString()).toBe("");
			expect(JSON.parse(child.stdout.toString())).toMatchObject({
				classification: "insufficient_evidence", expected: flags[1] ?? null, pass, diffs: [],
			});
		}
	});
});

describe("read-only probe", () => {
	function probe(overrides: Record<string, string> = {}) {
		const child = Bun.spawnSync(["/bin/bash", `${import.meta.dir}/probe.sh`], {
			env: {
				PATH: "/nonexistent-lifecycle-path", HOME: "/nonexistent-lifecycle-home",
				EZIL_LC_TOOLS: "missing-lifecycle-tool", ...overrides,
			},
		});
		expect(child.exitCode).toBe(0);
		expect(child.stderr.toString()).toBe("");
		return JSON.parse(child.stdout.toString());
	}

	it("emits one JSON object with nulls when external commands are unavailable", () => {
		const data = probe();
		expect(data.identity.boot_id).toBeNull();
		expect(data.identity.uid).toBeNull();
		expect(data.identity.provider).toBeNull();
		expect(data.tools.npm_prefix).toBeNull();
		expect(data.tools.commands["missing-lifecycle-tool"]).toEqual({
			path: null, realpath: null, version: null, sha256: null, stat: null,
		});
		expect(data.config.bashrc.sha256).toBeNull();
		expect(data.project).toBeNull();
		expect(Object.values(data.mounts)).toEqual([null, null, null, null]);
	});

	it("only records an explicit valid provider observation, never Cloudflare transport metadata", () => {
		for (const provider of ["aws", "cloudflare"]) {
			expect(probe({ EZIL_LC_PROVIDER: provider, CLOUDFLARE_DEPLOYMENT_ID: "transport-only" }).identity.provider).toBe(provider);
		}
		expect(probe({ EZIL_LC_PROVIDER: "unknown", CLOUDFLARE_DEPLOYMENT_ID: "transport-only" }).identity.provider).toBeNull();
	});

	it("escapes quotes, backslashes, controls and Unicode without Python", () => {
		const value = 'quote" slash\\ tab\t newline\n carriage\r control\x01 snowman☃';
		const data = probe({ CLOUDFLARE_DEPLOYMENT_ID: value, CLOUDFLARE_DURABLE_OBJECT_ID: "", UNRELATED_SECRET: "not-emitted" });
		expect(data.identity.CLOUDFLARE_DEPLOYMENT_ID).toBe(value);
		expect(data.identity.CLOUDFLARE_DURABLE_OBJECT_ID).toBe("");
		expect(JSON.stringify(data)).not.toContain("not-emitted");
		expect(JSON.stringify(data)).not.toContain("UNRELATED_SECRET");
	});

	it("records the parent shell and requested sentinel without a process-list command", () => {
		const data = probe({ EZIL_LC_SENTINEL_PID: String(process.pid) });
		expect(data.processes.shell.pid).toBe(process.pid);
		expect(data.processes.sentinel.pid).toBe(process.pid);
		expect(data.processes.sentinel_requested).toBe(true);
		expect(data.processes.shell.starttime).toMatch(/^\d+$/);
		expect(data.processes.shell).toEqual(data.processes.sentinel);
	});

	it("keeps an invalid sentinel null, splits multiline lists, and deduplicates names", () => {
		const data = probe({
			EZIL_LC_SENTINEL_PID: "invalid", EZIL_LC_TOOLS: "first\nsecond first",
			EZIL_LC_PROJECT: "/nonexistent-lifecycle-project", EZIL_LC_FILES: "one\ntwo one",
		});
		expect(data.processes.sentinel).toBeNull();
		expect(data.processes.sentinel_requested).toBe(true);
		expect(Object.keys(data.tools.commands)).toEqual(["first", "second"]);
		expect(data.project.HEAD).toBeNull();
		expect(data.project.files).toEqual({ one: null, two: null });
	});
});

describe("review fixes (PR #203)", () => {
	it("a tool that stops answering --version is lost even with the same bytes", () => {
		const after = snapshot();
		after.tools.commands.opencode.version = null as unknown as string;
		expect(classify(snapshot(), after).classification).toBe("lost");
	});

	it("a changed but present version string is not loss", () => {
		const after = snapshot();
		after.tools.commands.opencode.version = "1.1";
		expect(classify(snapshot(), after).classification).toBe("same_process");
	});

	it("a matching sentinel in another pid namespace is not a resumed checkpoint", () => {
		const after = snapshot();
		after.identity.boot_id = "boot-2";
		after.identity.pid_namespace = "pid:[4026532999]";
		expect(classify(snapshot(), after, { providerTransition: true }).classification).toBe("recreated_shell");
		const resumed = snapshot();
		resumed.identity.provider = "cloudflare";
		resumed.identity.boot_id = "boot-2";
		expect(classify(snapshot(), resumed, { providerTransition: true }).classification).toBe("resumed_checkpoint");
	});

	it("the history marker must be a whole line, not a later export of it", () => {
		const home = `${process.env.TMPDIR ?? "/tmp"}/ezil-lc-marker-${process.pid}-${Date.now()}`;
		require("node:fs").mkdirSync(home, { recursive: true });
		const run = (history: string) => {
			require("node:fs").writeFileSync(`${home}/.bash_history`, history);
			const child = Bun.spawnSync(["/bin/bash", `${import.meta.dir}/probe.sh`], {
				env: { PATH: "/usr/bin:/bin", HOME: home, EZIL_LC_TOOLS: "missing-lifecycle-tool", EZIL_LC_MARKER: "ezil-lifecycle-123" },
			});
			expect(child.exitCode).toBe(0);
			return JSON.parse(child.stdout.toString()).config.bash_history.marker_present;
		};
		try {
			expect(run('ls\nexport EZIL_LC_MARKER="ezil-lifecycle-123"\n')).toBe(false);
			expect(run("ls\nezil-lifecycle-123\n")).toBe(true);
		} finally {
			require("node:fs").rmSync(home, { recursive: true, force: true });
		}
	}, 30_000); // runs the real probe twice with real commands on PATH
});
