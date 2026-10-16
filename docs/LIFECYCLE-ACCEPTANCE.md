# Lifecycle acceptance

Lifecycle events have **not been executed**. They need separate approval. Use staging test computers only for M4/M6; never use a user's computer without consent. The local probe and fixture tests validate tooling, not provider lifecycle behavior.

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

After approval, run the probe in the same interactive terminal before and after **each** event below. Store snapshots on the operator's machine or approved durable storage outside the layer being tested. The probe writes no files and emits one JSON object; redirection by the operator saves it.

```bash
# In the staging computer's interactive Bash, before the event:
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
# Re-export the SAME tool, project, file list, marker, and original sentinel PID
# if the terminal opened a new shell. Do not start a replacement sentinel.
bash /workspace/.ezil-probe.sh > /approved-durable-location/M1a-after.json

# On the operator's machine, with copies of both snapshots:
bun tools/lifecycle/classify.ts M1a-before.json M1a-after.json --expect same_process
```

`EZIL_LC_TOOLS` defaults to `opencode`. Tool and project-file lists are whitespace separated (no shell evaluation or glob expansion; file names with whitespace are unsupported). Leave `EZIL_LC_PROJECT` unset to omit project checks. Only select nonsecret project files and a nonsecret marker. The probe hashes config/history without printing contents or the marker; it never emits process arguments or arbitrary environment values. Identity includes HOME and the two Cloudflare IDs only when set, and tool inspection includes PATH. Run it as the ordinary terminal user; root is not needed. It needs Bash 5 and coreutils; unavailable commands or unreadable files produce `null`. Python 3 is optional for JSON escaping. Tool version commands run under `timeout 10`; choose tools whose `--version` is read-only. The parent `$PPID` is the shell under test, so invoke with `bash ...` directly in that shell, without `exec` or a pipeline wrapper that changes its parent.

The JSON has `identity`, `processes`, `tools`, `config`, `project`, and `mounts` sections. Each process records numeric `pid`, string `starttime`, and `comm`; code-server, PTY host, and tmux lists are `null` when absent. Tools are keyed under `tools.commands`, with `path`, `realpath`, `version`, `sha256`, and `stat` (`inode`, `links`, `size`). Config objects are `bashrc`, `bash_history`, and `settings`; history also records `lines` and `marker_present`. Project has `HEAD` and file hashes keyed under `files`. Exact mount points are inspected; a directory on its parent's mount is reported as `null`.

The classifier evaluates, in order:

1. `lost`: a tool path/resolved path/hash, bashrc/settings hash, project HEAD/file hash changes (including becoming null), or a previously present history marker is missing. History hash changes alone allow normal history growth.
2. `same_process`: boot ID, PID namespace and shell PID/starttime match, along with the sentinel when requested. The boot ID is the host kernel's, so containers on one host share it; the PID namespace tells them apart.
3. `resumed_checkpoint`: `--provider-transition` was explicitly supplied and sentinel PID/starttime match. This is expected only for EC2 hibernation; the operator must verify the provider transition separately. `same_process` still takes precedence.
4. `recreated_shell`: files/tools compare equal, but boot or shell/sentinel identity differs. Missing process identity also falls here, since absent evidence cannot prove survival.

Output is `{classification, expected, pass, diffs:[{path,before,after}]}`. With `--expect`, a match exits 0 and a mismatch exits 1; without it the classifier exits 0. Diffs include observational changes such as inode, PTY host, tmux, mounts, history, and version. An unchanged tmux server cannot prove an unchanged shell. Missing and null fields compare equally; two unobservable file hashes do not prove those bytes survived. Keep the same probe inputs and inspect nulls and diffs before treating a result as lifecycle evidence. Malformed JSON or CLI arguments exit 1.

C = Cloudflare; A = AWS. These are expected outcomes, with unconfirmed and known-gap entries preserved:

| Event | Files / installed tools | History & config | Terminal session / sentinel |
|---|---|---|---|
| M1a browser close+reopen < 5 min | C,A kept | kept | same process expected (ptyHost grace); tmux: same |
| M1b browser close 5–9 min | kept | kept | ptyHost UNCONFIRMED; tmux same |
| M2 idle stop (C 10 min, A 600 s + load<0.5) | C restored from R2; A kept on EBS | kept only if saved before stop | lost -> new shell |
| M3 code-server /restart (C) / systemctl restart ezil-desktop (A) | kept | kept | ptyHost lost; tmux C same (inferred), A lost |
| M4 container replacement (C staging rollout; A wake=replace) | C restored; A kept, new instance id, same data volume id | kept | lost |
| M5 host stop/start (A; C host restart observe-only) | kept | kept | lost (hibernation off) |
| M6 image upgrade (C new digest; A new lower) | C cross-image restore; A expected FAIL lower_digest_mismatch (known gap) | kept | lost |
| M7 oversize npm -g (> 512 MiB, C) | not saved; notice shown; stop completes | — | — |

“Lost” in the terminal column means process loss, usually classifier `recreated_shell` when files survive. Use `--expect recreated_shell` for M2–M5 and a successful C M6 restore. M1b needs observation rather than an assumed PTY result. A M6's `lower_digest_mismatch` must be checked in provider evidence; the classifier detects any resulting file loss but cannot diagnose that provider error. M4 instance/data-volume IDs and M6 image digests need separate provider observations: the probe does not query metadata APIs. M7's notice, snapshot size limit, and stop completion also need separate provider evidence; this probe cannot prove them alone.

Local validation from the worktree root:

```bash
(cd tools && PATH=/root/.bun/bin:$PATH bun test lifecycle/)
bash -n tools/lifecycle/probe.sh
EZIL_LC_TOOLS=bash bash tools/lifecycle/probe.sh | python3 -m json.tool > /dev/null
```

The sandbox check selects `bash` to avoid invoking an AI CLI. `tools/test.sh tools` uses recursive Bun discovery and finds this suite, and `tools/tsconfig.json` includes `lifecycle/*.ts`, so `bun run --cwd tools typecheck` checks it.
