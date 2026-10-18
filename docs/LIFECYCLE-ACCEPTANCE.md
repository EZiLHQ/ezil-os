# Lifecycle acceptance

Hosted lifecycle events have **not been executed**. They need separate approval for exact computers, writes and spending. Existing staging shares production authentication and database; it is not isolated. Never run destructive or replacement tests on an existing user computer. Local probes and fixtures validate tooling, not provider lifecycle behavior. Preserve the **20-cycle hosted acceptance** gate from AWS-COMPUTERS.md before rollout. Cloudflare migration remains deferred.

Installed-command survival is not running-process survival. A restored executable can have the same path and hash with a new inode while its former process is gone.

| Layer | What can survive |
|---|---|
| Image | Base OS and preinstalled commands; changes when the image digest changes. |
| Writable layer | Installed commands and modified files; requires preservation or restoration on replacement. |
| Durable storage | C: R2 snapshot; A: EBS data volume. Stores saved bytes, not running processes. |
| Terminal frontend | Browser view and reconnection; reopening does not prove shell survival. |
| PTY host | VS Code terminal backend; grace periods may keep terminals alive, restart can kill them. |
| Shell | PID plus `/proc` starttime identifies the running shell; history must be saved separately. |
| Processes | Sentinel and tmux server identities prove their own survival independently of files and the shell. |

## Real installed-tool evidence (not fixtures)

A fixture or sentinel proves the storage path; only the real tool proves the founder's case. For each run:

1. Install the real tool once, the way a user does (`npm install -g opencode-ai`), and record the version installed. Never reinstall it during the run: a reinstall voids every later "kept" result.
2. **Cloudflare gate, before any stop event.** At least 6 minutes after the install, the computer's R2 `system/.ezil-snapshots/latest.json` must show a new `generation` and `opencode-ai` in `replay.npm`. If it does not, the install was never saved: record the run as `lost` at M2 without stopping anything further. On production at 74f5a88 this gate is expected to fail (the opencode install exceeds the 512 MiB system-layer cap); it should pass only with the held system-layer fixes.
3. **AWS host evidence.** On a canary computer, bake `canaryConsole: true` and `canaryTools: ["opencode"]`. Each boot and shutdown then writes a `tool` serial record with `status`, `size` and package `version`, read without executing or reinstalling anything (see infra/host-agent/README.md).
4. **In the terminal**, `probe.sh` records `command -v opencode`, its resolved path, `sha256`, `stat` and `opencode --version` before and after each event. The tool passes only if the path, resolved path and hash are unchanged and `--version` still answers, with no reinstall in between.

The computer has no checkout of this repository. Paste `tools/lifecycle/probe.sh` into the computer once (for example as `/workspace/.ezil-probe.sh` from the editor) and record its `sha256sum` with every snapshot, so both snapshots come from the same probe.

## Running the matrix

After separate hosted approval, install `opencode-ai` once and run the probe inside interactive Bash in tmux before and after **each** event below. For M2–M5, a new tmux server/session is allowed; type `opencode --version` there without reinstalling. This accepts saved command availability, not survival of the old tmux process. Seed nonsecret project files, `.bashrc`, `/workspace/.ezil/settings.json` and a history marker before the first measurement. Store snapshots on the operator's machine or approved durable storage outside the layer being tested. The probe writes no files and emits one JSON object; redirection by the operator saves it.

```bash
# In the approved test computer's interactive Bash inside tmux, before the event:
# Copy the actual provider from authenticated Settings/placement evidence:
export EZIL_LC_PROVIDER='aws'
export EZIL_LC_TOOLS='opencode'
export EZIL_LC_PROJECT=/workspace/my-project
export EZIL_LC_FILES='package.json README.md'
export EZIL_LC_MARKER="ezil-lifecycle-$(date +%s)"
history -s "$EZIL_LC_MARKER"
history -a
sleep 86400 &
export EZIL_LC_SENTINEL_PID=$!
printf 'Keep this sentinel PID for the after probe: %s\n' "$EZIL_LC_SENTINEL_PID"
bash /workspace/.ezil-probe.sh > /approved-durable-location/M1a-before.json

# Perform the separately approved event. In the reconnected terminal:
# Re-export the SAME provider, tool, project, file list, marker, and original sentinel PID
# if the terminal opened a new shell. Do not start a replacement sentinel.
bash /workspace/.ezil-probe.sh > /approved-durable-location/M1a-after.json

# On the operator's machine, with copies of both snapshots:
bun tools/lifecycle/classify.ts M1a-before.json M1a-after.json --expect same_process
```

`EZIL_LC_TOOLS` defaults to `opencode`. Tool and project-file lists are whitespace separated (no shell evaluation or glob expansion; file names with whitespace are unsupported). A populated Git project and file list are required for persistence acceptance; omitting them produces insufficient evidence. `EZIL_LC_PROVIDER` must be `aws` or `cloudflare`, copied from actual placement evidence. It is operator-supplied context, not proof from a cloud query; retain the independent provider observation alongside the snapshots. Only select nonsecret project files and a nonsecret marker. The probe hashes config/history without printing contents or the marker; it never emits process arguments or arbitrary environment values. Identity includes HOME and the two Cloudflare IDs only when set, and tool inspection includes PATH. Run it as the ordinary terminal user; root is not needed. It needs Bash 5 and coreutils; unavailable commands or unreadable files produce `null`. Python 3 is optional for JSON escaping. Tool version commands run under `timeout 10`; choose tools whose `--version` is read-only. The parent `$PPID` is the shell under test, so invoke with `bash ...` directly in that shell, without `exec` or a pipeline wrapper that changes its parent.

The JSON has `identity`, `processes`, `tools`, `config`, `project`, and `mounts` sections. Each process records numeric `pid`, string `starttime`, and `comm`; code-server, PTY host, and tmux lists are `null` when absent. Tools are keyed under `tools.commands`, with `path`, `realpath`, `version`, `sha256`, and `stat` (`inode`, `links`, `size`). Config objects are `bashrc`, `bash_history`, and `settings`; history also records `lines` and `marker_present`. Project has `HEAD` and file hashes keyed under `files`. Exact mount points are inspected; a directory on its parent's mount is reported as `null`.

The classifier evaluates, in order:

1. `lost`: tool paths/bytes change or execution stops answering; project/config bytes change; history loses the marker, shrinks, or changes at the same line count; provider changes without an explicit transition.
2. `insufficient_evidence`: required observations are missing or invalid. Required evidence includes provider, boot/PID namespace and shell identity, opencode path/hash/version, npm prefix/PATH, configuration/history hashes and marker, and project HEAD/file hashes. Two null hashes never prove persistence.
3. `same_process`: boot ID, PID namespace and shell PID/starttime match, with the sentinel when requested.
4. `resumed_checkpoint`: an explicitly observed provider transition plus matching PID namespace and sentinel identity. Hibernation is off and this is outside current acceptance.
5. `recreated_shell`: required saved-state evidence matches but process identity changed. This is the expected M2–M5 success case.

Output includes `{classification, expected, pass, diffs, missingEvidence}`. Insufficient evidence always fails. Without `--expect`, loss fails; with it, the expected classification must match. Diffs retain observational changes such as inode, PTY host, tmux, mounts and version. A surviving tmux server does not prove a surviving shell. Malformed input/arguments fail. Inspect every result and the independent provider observations before claiming lifecycle acceptance.

C = Cloudflare; A = AWS. These are expected outcomes, with unconfirmed and known-gap entries preserved:

| Event | Files / installed tools | History & config | Terminal session / sentinel |
|---|---|---|---|
| M1a browser close+reopen < 5 min | C,A kept | kept | same process expected (ptyHost grace); tmux: same |
| M1b browser close 5–9 min | kept | kept | ptyHost UNCONFIRMED; tmux same |
| M2 idle stop (C 10 min, A 600 s + load<0.5) | C restored from R2; A kept on EBS | kept only if saved before stop | lost -> new shell |
| M3 code-server /restart (C) / systemctl restart ezil-desktop (A) | kept | kept | ptyHost lost; tmux C same (inferred), A lost |
| M4 resource replacement (separately authorized test computer) | Container-only: same host/volume; AWS instance replacement: new instance, same retained volume | kept | lost |
| M5 EC2 stop/start in place (A; C host restart observe-only) | same instance and data volume; bytes kept | kept | lost (hibernation off) |
| M6 image upgrade (C new digest; A new lower) | C cross-image restore; A expected FAIL lower_digest_mismatch (known gap) | kept | lost |
| M7 oversize npm -g (> 512 MiB, C) | not saved; notice shown; stop completes | — | — |

“Lost” in the terminal column means process loss, usually classifier `recreated_shell` when files survive. Use `--expect recreated_shell` for M2–M5 and a successful C M6 restore. M1b needs observation rather than an assumed PTY result. A M6's `lower_digest_mismatch` must be checked in provider evidence; the classifier detects any resulting file loss but cannot diagnose that provider error. M4/M5 instance/data-volume IDs and M6 image digests need separate provider observations: the probe does not query metadata APIs. M7's notice, snapshot size limit, and stop completion also need separate provider evidence; this probe cannot prove them alone.

Local validation from the worktree root:

```bash
(cd tools && PATH=/root/.bun/bin:$PATH bun test lifecycle/)
bash -n tools/lifecycle/probe.sh
EZIL_LC_TOOLS=bash bash tools/lifecycle/probe.sh | python3 -m json.tool > /dev/null
```

The sandbox smoke check selects `bash` to avoid invoking an AI CLI. It validates probe JSON only and cannot satisfy opencode persistence acceptance. `tools/test.sh tools` uses recursive Bun discovery and finds this suite, and `tools/tsconfig.json` includes `lifecycle/*.ts`, so `bun run --cwd tools typecheck` checks it.
