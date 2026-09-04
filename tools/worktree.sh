#!/usr/bin/env bash
#
# One worktree per task, hydrated in 12 MB instead of 1.1 GB.
#
# ## Why this is a symlink farm and not a copy
#
# The reference harness at /data/openclaw/workspace hydrates worktrees with
# `cp --reflink=auto`, which on APFS/btrfs is a copy-on-write clone costing
# almost nothing. `/data` here is **ext4**. MEASURED on this volume rather than
# assumed (a platform claim in a comment is a hypothesis until someone issues
# the call):
#
#     $ df -T /data                 -> /dev/sdb  ext4
#     $ cp --reflink=always a b     -> "failed to clone ...: Operation not
#                                      supported"  (exit 1)
#     $ cp --reflink=auto   a b     -> exit 0, a full byte copy
#
# So the reflink form does not fail here, it silently degrades. MEASURED sizes
# on this repo: the seven node_modules stores total **1.1 GB**
# (`du -shc {,app/,worker/,shell/,sdk/,mcp/,local/}node_modules`), and one
# worktree hydrated by this script is **12 MB** (`du -sh` of a fresh
# `add smoke`). Eight worktrees live at once is the normal state of a round:
# 96 MB against 8.8 GB, and 8.8 GB of copying per round in wall time.
#
# ## Why each node_modules is a DIRECTORY of links, not one link
#
# This is the difference that cost a task on the sibling project to find, and
# EZiL-OS has its own sharper version of it.
#
# `mcp/` depends on the SDK as `"@ezil-os/sdk": "file:../sdk"`. Bun does not
# make that a symlink to `../sdk`: it materialises
# `mcp/node_modules/@ezil-os/sdk` as a REAL DIRECTORY whose files are
# individual symlinks back into the main checkout (measured: `package.json`,
# `tsconfig.json`, `src/*.ts` all point at `<main>/sdk/...`).
#
# So a worktree that symlinks `mcp/node_modules` wholesale -- which is how
# every worktree on this machine was hydrated before this script existed --
# typechecks `mcp/` against the MAIN tree's SDK sources. A task editing
# `sdk/src` sees `mcp` stay green in its worktree and break on merge, and
# nothing anywhere reports it. Verified before this script was written:
#
#     readlink -f .claude/worktrees/O3/mcp/node_modules/@ezil-os/sdk
#     -> /data/openclaw/projects/ezil/EZiL-OS/mcp/node_modules/@ezil-os/sdk
#        (the MAIN tree)
#
# So: every third-party entry is a symlink to the main store (the whole point
# -- they are large and identical), and every `@ezil-os/*` entry is rewritten
# to point INSIDE this worktree. The origin is derived from the filesystem
# (the link `<pkg>/package.json` points at), never from the package name, so
# it keeps working if bun changes how it materialises a `file:` dependency.
#
# A `.bin` is why this uses `find` and not a glob: `.bin` holds `tsc`, and a
# glob skips dotted entries silently -- the worktree then fails with
# "tsc: command not found", which reads like a broken install rather than a
# missing link.
#
# ## tools/
#
# `tools/` has no node_modules of its own and no dependencies to install; its
# `typecheck` script needs a `tsc` and its tsconfig already points `typeRoots`
# at `../sdk/node_modules/@types`. It gets a link farm built from
# `sdk/node_modules` so `bun run typecheck` works there with no PATH prefix.
#
# ## Secrets
#
# `.env*` and `.dev.vars*` are gitignored (`worker/.dev.vars` is NOT -- see the
# hand-off in this row's report), so `git worktree add` does not bring them and
# every worktree would otherwise fail at boot with a config error that looks
# like a code bug. They are copied (not symlinked, so a task cannot edit the
# real one) at mode 600, and shredded on removal. `*.example` files are
# committed templates and are left to git.
#
# ## .vercel and .wrangler
#
# `app/.vercel/project.json` is the Vercel project linkage. A worktree running
# `vercel link` or `vercel pull` would rewrite it -- so it is COPIED, and the
# copy is then made read-only.
#
# Be precise about which half does the work. **The copy is the protection**: a
# write in the worktree lands on the worktree copy and the main tree file is
# untouched. Symlinking would give none of that -- permissions on a symlink are
# ignored, and a directory symlink sends the write straight through to main.
#
# The read-only bits are a speed bump, not a barrier, and MEASURED as such:
# these agents run as uid 0, and root ignores the permission bits --
# `echo x > <wt>/app/.vercel/project.json` succeeded and truncated the
# worktree copy, while the main tree file was still the real linkage. Do not
# read `chmod a-w` here as "cannot be changed"; read it as "is not changed by
# accident, and never in the main tree".
#
# `worker/.wrangler` is local dev-server state (R2, DO, cache). It is neither
# copied nor linked: the worktree gets its own empty one, so a worktree running
# `wrangler dev` can never write into the main tree local state.
#
# Usage:
#   tools/worktree.sh add    <task-id> [base-ref]   (base defaults to `main`)
#   tools/worktree.sh remove <task-id>
#   tools/worktree.sh list

set -euo pipefail

# ── Where the MAIN checkout is ──────────────────────────────────────────────
# NOT `dirname "$0"/..`. This script is committed, so every worktree carries
# its own copy, and a task that runs `tools/worktree.sh` from inside its own
# worktree would otherwise take THAT worktree for the repository: it would nest
# worktrees under `.claude/worktrees/<id>/.claude/worktrees/`, and hydrate the
# new one from a tree whose node_modules are already symlinks.
#
# `--git-common-dir` is the one path that is identical from every worktree: it
# names the main `.git` directory, never the per-worktree `.git` stub file.
SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname -- "$(git -C "$SELF_DIR" rev-parse --path-format=absolute --git-common-dir)")"
BASE_DIR="$REPO/.claude/worktrees"

warn () { printf '%s\n' "worktree.sh: $*" >&2; }

# ── Link one node_modules ───────────────────────────────────────────────────
# A real directory in the worktree whose entries are symlinks into the main
# store, with the `@ezil-os` scope rewritten to point inside the worktree.
link_farm () {
    local src="$1" dst="$2" wt="$3"
    [ -d "$src" ] || return 0
    mkdir -p "$dst"
    local entry base
    while IFS= read -r -d "" entry; do
        base="$(basename -- "$entry")"
        if [ "$base" = "@ezil-os" ]; then
            link_workspace_scope "$entry" "$dst/@ezil-os" "$wt"
        else
            ln -sfn "$entry" "$dst/$base"
        fi
    done < <(find "$src" -mindepth 1 -maxdepth 1 -print0)
}

# ── The @ezil-os scope: never the main tree ─────────────────────────────────
# Derives where each entry really came from and relinks it to the
# matching directory inside the worktree. An entry whose origin cannot be placed
# inside the worktree is LEFT OUT with a loud warning rather than pointed at main:
# an unresolved import fails honestly, a silent link to main is the exact
# false-green this script exists to prevent.
link_workspace_scope () {
    local scope_src="$1" scope_dst="$2" wt="$3"
    mkdir -p "$scope_dst"
    local pkg name origin rel
    for pkg in "$scope_src"/*; do
        [ -e "$pkg" ] || continue
        name="$(basename -- "$pkg")"
        origin=""
        if [ -L "$pkg" ]; then
            # A plain symlink dependency (how bun links a workspace member).
            origin="$(readlink -f -- "$pkg" 2>/dev/null || true)"
        elif [ -L "$pkg/package.json" ]; then
            # A `file:` dependency: a real directory of per-file symlinks. The
            # package.json link is what says where the real package lives.
            origin="$(dirname -- "$(readlink -f -- "$pkg/package.json")")"
        fi
        rel=""
        if [ -n "$origin" ]; then
            rel="$(realpath --relative-to="$REPO" -- "$origin" 2>/dev/null || true)"
        fi
        case "$rel" in
            "" | .. | ../* | /*) rel="" ;;
        esac
        if [ -n "$rel" ] && [ -d "$wt/$rel" ]; then
            ln -sfn "$wt/$rel" "$scope_dst/$name"
        else
            warn "@ezil-os/$name has no counterpart inside $wt (origin: ${origin:-unknown});"
            warn "  leaving it UNLINKED. Linking the main tree would typecheck this worktree"
            warn "  against sources it is not editing."
        fi
    done
}

hydrate () {
    local wt="$1" rel parent

    # Every node_modules in the main tree, at most three levels down
    # (`./node_modules`, `./<pkg>/node_modules`, `./worker/sidecar/node_modules`).
    # `-prune` on the match so find never walks a store of 100k files, and
    # `.git`/`.claude` pruned so it never walks the object database or the
    # sibling worktrees.
    while IFS= read -r rel; do
        rel="${rel#./}"
        parent="$(dirname -- "$rel")"
        # A package that does not exist at this base ref has nothing to hydrate.
        [ -d "$wt/$parent" ] || continue
        link_farm "$REPO/$rel" "$wt/$rel" "$wt"
    done < <(cd "$REPO" && find . -maxdepth 3 \
        \( -name .git -o -name .claude \) -prune -o \
        -name node_modules -type d -print -prune)

    # `tools/` has no node_modules and no install of its own; borrow the SDK
    # store so `bun run typecheck` finds a tsc. Skipped if tools/ grows a real
    # one, which the loop above would then have handled.
    if [ ! -e "$REPO/tools/node_modules" ] && [ -d "$wt/tools" ]; then
        link_farm "$REPO/sdk/node_modules" "$wt/tools/node_modules" "$wt"
    fi

    # Secrets: copied at 0600, never symlinked.
    local old
    old="$(umask)"
    umask 077
    while IFS= read -r rel; do
        rel="${rel#./}"
        parent="$(dirname -- "$rel")"
        [ -d "$wt/$parent" ] || continue
        cp -- "$REPO/$rel" "$wt/$rel"
        chmod 600 "$wt/$rel"
    done < <(cd "$REPO" && find . -maxdepth 3 \
        \( -name .git -o -name .claude -o -name node_modules \) -prune -o \
        -type f \( -name ".env" -o -name ".env.*" -o -name ".dev.vars" -o -name ".dev.vars.*" \) \
        ! -name "*.example" -print)
    umask "$old"

    # Vercel linkage: copied, then read-only. See the header.
    if [ -d "$REPO/app/.vercel" ] && [ -d "$wt/app" ]; then
        rm -rf -- "$wt/app/.vercel"
        cp -R -- "$REPO/app/.vercel" "$wt/app/.vercel"
        chmod -R a-w "$wt/app/.vercel"
    fi

    # Wrangler state: the worktree gets its own, never the main tree store.
    if [ -d "$wt/worker" ]; then
        mkdir -p "$wt/worker/.wrangler/tmp"
    fi
}

# True when $1 resolves to a path strictly inside $2. Used before any `rm -rf`.
inside () {
    local p q
    p="$(readlink -f -- "$1" 2>/dev/null)" || return 1
    q="$(readlink -f -- "$2" 2>/dev/null)" || return 1
    [ -n "$p" ] || return 1
    [ -n "$q" ] || return 1
    case "$p" in
        "$q"/*) return 0 ;;
    esac
    return 1
}

teardown () {
    local wt="$1" f
    [ -d "$wt" ] || return 0

    # Secrets first: a shred that runs after the tree is gone shreds nothing.
    while IFS= read -r f; do
        shred -u -- "$f" 2>/dev/null || rm -f -- "$f"
    done < <(find "$wt" -maxdepth 3 \
        \( -name .git -o -name node_modules \) -prune -o \
        -type f \( -name ".env" -o -name ".env.*" -o -name ".dev.vars" -o -name ".dev.vars.*" \) -print)

    # Then the link farms, before git touches the tree.
    #
    # Five sibling agents read the main store through these links, so this is
    # the one place in the repository where a wrong `rm -rf` is unrecoverable.
    # Two guards, not one:
    #   * a SYMLINK is unlinked, never followed -- this is what a worktree
    #     hydrated the old way (one link for the whole directory) looks like,
    #     and `rm -rf` on the path would otherwise delete the main store;
    #   * a real directory is removed only after `readlink -f` puts it strictly
    #     inside the worktree.
    while IFS= read -r f; do
        if [ -L "$f" ]; then
            rm -f -- "$f"
        elif inside "$f" "$wt"; then
            rm -rf -- "$f"
        else
            warn "refusing to remove $f -- it does not resolve inside $wt"
        fi
    done < <(find "$wt" -maxdepth 3 -name node_modules \( -type d -o -type l \) -print -prune)

    # The read-only Vercel copy: git cannot delete a file in a directory it
    # cannot write.
    if [ -e "$wt/app/.vercel" ]; then
        chmod -R u+w "$wt/app/.vercel" 2>/dev/null || true
    fi
}

case "${1:-}" in
add)
    id="${2:?task id required}"
    base="${3:-main}"
    wt="$BASE_DIR/$id"
    # A stale registration (directory deleted by hand, never pruned) makes the
    # `git worktree add` below fail with a message about a path that is not
    # there. Prune first so the refusals underneath are the real ones.
    git -C "$REPO" worktree prune
    if [ -e "$wt" ]; then
        warn "worktree exists: $wt -- remove it first (tools/worktree.sh remove $id)"
        exit 1
    fi
    if git -C "$REPO" show-ref --verify --quiet "refs/heads/task/$id"; then
        warn "branch task/$id already exists -- delete it or pick another id"
        exit 1
    fi
    mkdir -p "$BASE_DIR"
    git -C "$REPO" worktree add -q "$wt" -b "task/$id" "$base"
    hydrate "$wt"
    printf '%s\n' "$wt"
    ;;
remove)
    id="${2:?task id required}"
    wt="$BASE_DIR/$id"
    case "$wt" in
        "$BASE_DIR"/?*) ;;
        *) warn "refusing to remove $wt -- not a worktree under $BASE_DIR"; exit 1 ;;
    esac
    teardown "$wt"
    git -C "$REPO" worktree remove --force "$wt" 2>/dev/null || rm -rf -- "$wt"
    git -C "$REPO" branch -D "task/$id" >/dev/null 2>&1 || true
    git -C "$REPO" worktree prune
    printf '%s\n' "removed $id"
    ;;
list)
    git -C "$REPO" worktree list
    ;;
*)
    sed -n '2,99p' "${BASH_SOURCE[0]}"
    exit 1
    ;;
esac
