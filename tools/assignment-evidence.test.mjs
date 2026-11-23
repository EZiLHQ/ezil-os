import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";

const captureCli = fileURLToPath(new URL("./assignment-evidence.mjs", import.meta.url));
const reviewCli = fileURLToPath(new URL("./assignment-evidence-review.mjs", import.meta.url));
const assignmentVersion = "version-1";
const attemptId = "test-attempt";
const remoteRef = "refs/heads/assignment";
const temporaryRoots = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "assignment-evidence-"));
	temporaryRoots.push(root);
	const repo = join(root, "checkout");
	const remote = join(root, "origin.git");
	const env = {
		...process.env,
		GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
		GIT_CONFIG_NOSYSTEM: "1",
	};
	mkdirSync(repo);
	const git = (...args) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trimEnd();
	git("init", "-q", "--initial-branch=assignment");
	git("init", "-q", "--bare", remote);
	git("config", "user.name", "Assignment Test");
	git("config", "user.email", "assignment@example.invalid");
	git("remote", "add", "origin", remote);
	const write = (name, content) => writeFileSync(join(repo, name), content);
	const commit = message => {
		git("add", "--all");
		git("commit", "-q", "-m", message);
		return git("rev-parse", "HEAD");
	};
	const push = () => git("push", "-q", "origin", `HEAD:${remoteRef}`);
	write("app.txt", "original assignment\n");
	const baseSha = commit("Assignment base");
	push();
	return { root, repo, env, git, write, commit, push, baseSha };
}

function capture(f, phase, args = [], name = phase, identity = {}) {
	const dir = join(f.root, name);
	execFileSync("node", [
		captureCli,
		"--repo", f.repo,
		"--out", dir,
		"--attempt-id", identity.attemptId ?? attemptId,
		"--assignment-version", identity.assignmentVersion ?? assignmentVersion,
		"--base-sha", identity.baseSha ?? f.baseSha,
		"--phase", phase,
		...args,
	], { env: f.env, encoding: "utf8" });
	return { dir, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) };
}

function review(...snapshots) {
	const stdout = execFileSync("node", [reviewCli, ...snapshots.map(snapshot => snapshot.dir)], { encoding: "utf8" });
	return JSON.parse(stdout);
}

function expectReviewFailure(...snapshots) {
	const result = spawnSync("node", [reviewCli, ...snapshots.map(snapshot => snapshot.dir)], { encoding: "utf8" });
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	expect(result.status).not.toBe(0);
}

test("captures manual and agent changes and reviews a verified submission using observed timestamps", () => {
	const f = fixture();
	const baseline = capture(f, "baseline", ["--observe", "code-ready=2026-11-19T10:00:00Z"]);
	expect(baseline.manifest).toMatchObject({
		schemaVersion: 1, attemptId, assignmentVersion, phase: "baseline", baseSha: f.baseSha, headSha: f.baseSha,
		remote: { ref: null, headSha: null, status: "not-checked", submittedSha: null },
	});

	f.write("app.txt", "manual change\n");
	const manualSha = f.commit("Apply manual edit");
	f.write("draft.txt", "staged draft\n");
	f.git("add", "draft.txt");
	f.write("draft.txt", "staged draft\nunstaged line\n");
	f.write("notes.txt", "untracked note\n");
	const statusBefore = f.git("status", "--porcelain=v1");
	const manual = capture(f, "manual");
	expect(manual.manifest.headSha).toBe(manualSha);
	expect(readFileSync(join(manual.dir, "committed.patch"), "utf8")).toContain("+manual change");
	expect(readFileSync(join(manual.dir, "staged.patch"), "utf8")).toContain("+staged draft");
	expect(readFileSync(join(manual.dir, "unstaged.patch"), "utf8")).toContain("+unstaged line");
	expect(readFileSync(join(manual.dir, "status.txt"), "utf8")).toContain("notes.txt");
	expect(f.git("status", "--porcelain=v1")).toBe(statusBefore);

	f.write("app.txt", "manual change\nagent change\n");
	const agentSha = f.commit("Apply agent edit");
	const chatPath = join(f.root, "chat.json");
	const chat = JSON.stringify([{ role: "user", content: "Add the agent change" }]);
	writeFileSync(chatPath, chat);
	const agent = capture(f, "agent", [
		"--attach", `chat=${chatPath}`,
		"--observe", "prompt-submitted=2026-11-19T10:01:00Z",
		"--observe", "first-visible-output=2026-11-19T10:01:02.500Z",
	]);
	expect(agent.manifest.headSha).toBe(agentSha);
	const [attachment] = agent.manifest.attachments;
	expect(attachment.kind).toBe("chat");
	expect(attachment.sha256).toBe(createHash("sha256").update(chat).digest("hex"));
	writeFileSync(chatPath, "edited source after capture\n");
	expect(readFileSync(join(agent.dir, attachment.path), "utf8")).toBe(chat);

	f.push();
	const submission = capture(f, "submission", [
		"--remote-ref", remoteRef,
		"--submitted-sha", agentSha,
		"--observe", "submitted=2026-11-19T10:03:00Z",
	]);
	expect(submission.manifest.remote).toMatchObject({
		ref: remoteRef, headSha: agentSha, status: "match", submittedSha: agentSha,
	});
	const report = review(submission, manual, agent, baseline);
	expect(report).toMatchObject({
		attemptId, assignmentVersion, baseSha: f.baseSha,
		intervals: { assignmentElapsedMs: 180_000, firstVisibleOutputMs: 2_500 },
		submission: { status: "match", sha: agentSha },
	});
	expect(report.snapshots).toHaveLength(4);
});

test("preserves an uncommitted interrupted attempt and declines to verify an unpublished SHA", () => {
	const f = fixture();
	const baseline = capture(f, "baseline", ["--observe", "code-ready=2026-11-19T10:00:00Z"]);
	f.write("app.txt", "uncommitted interrupted edit\n");
	const interrupted = capture(f, "interrupted", ["--observe", "prompt-submitted=2026-11-19T10:02:00Z"]);
	const laterOutput = capture(f, "agent", ["--observe", "first-visible-output=2026-11-19T10:04:00Z"]);
	expect(interrupted.manifest.headSha).toBe(f.baseSha);
	expect(readFileSync(join(interrupted.dir, "unstaged.patch"), "utf8")).toContain("+uncommitted interrupted edit");
	const interruptedReport = review(baseline, interrupted, laterOutput);
	expect(interruptedReport.intervals).toMatchObject({ assignmentElapsedMs: null, firstVisibleOutputMs: null });
	expect(interruptedReport.submission).toMatchObject({ status: "missing", sha: null });
	expect(interruptedReport.gaps.length).toBeGreaterThan(0);

	const unpublishedSha = f.commit("Commit after interruption");
	const mismatch = capture(f, "submission", ["--remote-ref", remoteRef, "--submitted-sha", unpublishedSha]);
	expect(mismatch.manifest.remote).toMatchObject({
		ref: remoteRef, headSha: f.baseSha, status: "mismatch", submittedSha: unpublishedSha,
	});
	expect(review(baseline, mismatch).submission).toMatchObject({ status: "mismatch", sha: null });

	const missingRef = "refs/heads/missing";
	const unavailable = capture(f, "submission", ["--remote-ref", missingRef, "--submitted-sha", unpublishedSha], "missing-ref");
	expect(unavailable.manifest.remote).toMatchObject({
		ref: missingRef, headSha: null, status: "unavailable", submittedSha: unpublishedSha,
	});
	expect(review(baseline, unavailable).submission).toMatchObject({ status: "unavailable", sha: null });
});

test("rejects mixed identities and corrupted evidence", () => {
	const f = fixture();
	const baseline = capture(f, "baseline");
	f.write("app.txt", "edited assignment\n");
	const nextSha = f.commit("Edit assignment");
	const otherAttempt = capture(f, "agent", [], "other-attempt", { attemptId: "other-attempt" });
	const otherBase = capture(f, "agent", [], "other-base", { baseSha: nextSha });
	expectReviewFailure(baseline, otherAttempt);
	expectReviewFailure(baseline, otherBase);

	const attachmentSource = join(f.root, "test-output.txt");
	writeFileSync(attachmentSource, "fixture tests passed\n");
	const agent = capture(f, "agent", ["--attach", `tests=${attachmentSource}`]);
	expect(review(baseline, agent).snapshots).toHaveLength(2);

	const attachmentPath = join(agent.dir, agent.manifest.attachments[0].path);
	const originalAttachment = readFileSync(attachmentPath);
	writeFileSync(attachmentPath, "modified test results\n");
	expectReviewFailure(baseline, agent);
	writeFileSync(attachmentPath, originalAttachment);

	const patchPath = join(agent.dir, "committed.patch");
	writeFileSync(patchPath, "modified patch\n");
	expectReviewFailure(baseline, agent);
});
