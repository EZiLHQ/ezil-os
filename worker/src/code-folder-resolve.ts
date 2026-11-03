/**
 * code-folder-resolve.ts — per-tab Code folder continuity, the Cloudflare computer's WALK
 * (single writer e1cd418a; the lexical half is `./code-folder.ts`, written by the editor lane).
 *
 * `planCodeFolder` has already refused anything outside the computer's root, `.ezil/**` and
 * `projects/<uuid>/**`, and normalised the rest to `rel`: '' for the root, else `a/b/c` with no
 * empty, `.` or `..` segment, no control character and no backslash. This module walks `rel`
 * below the root INSIDE the container and answers one code:
 *   - `restored`: the root is a directory and every component of `rel` is a real directory
 *     (lstat: never a symlink, so no component can lead outside the root or into a project's
 *     repository, which the lexical refusals alone could not promise);
 *   - `symlink`: a component is a symlink, dangling or not (checked BEFORE anything that follows it);
 *   - `missing`: the root or a component does not exist;
 *   - `not_directory`: a component exists and is not a directory;
 *   - `error`: anything else (a timeout, a non-zero exit, a refused exec, any other output).
 * Never a path: the answer is a code, and only `restored` lets `settleCodeFolder` add a folder.
 *
 * The script is a constant. The root and `rel` reach it only as exec env values (never
 * interpolated into the command), `set -f` keeps `*`, `?` and `[` in names literal, and the
 * split on `/` uses a local IFS. Every tested path is absolute, so a name starting with `-` is
 * never read as an option. The exec is bounded by CODE_FOLDER_RESOLVE_TIMEOUT_MS, because the
 * walk runs inside the Code mint.
 *
 * Trust: the walk runs in the person's own container and reports to that person's own mint, so a
 * result the container's root could shape changes only which of their own folders opens. A folder
 * swapped for a symlink or a bind mount after the walk is that same person's act (residual).
 */
import type { CodeFolderOutcome, CodeFolderResolver } from './code-folder';
import type { RepoOpenExec } from './repo-open';

/** The longest walk; past it the answer is `error` and today's default folder opens. */
export const CODE_FOLDER_RESOLVE_TIMEOUT_MS = 5_000;
/** Exec env names: the computer's root and the planner's `rel`. Per command, not deployment config. */
export const CODE_FOLDER_ROOT_ENV = 'EZIL_CODE_FOLDER_ROOT';
export const CODE_FOLDER_REL_ENV = 'EZIL_CODE_FOLDER_REL';
/** What the walk itself may answer; `outside`, `not_allowed`, `invalid`, `unverified` and `too_long` are the planner's. */
export const CODE_FOLDER_WALK_OUTCOMES = ['restored', 'missing', 'not_directory', 'symlink', 'error'] as const satisfies readonly CodeFolderOutcome[];

/**
 * The in-container walk (bash or any POSIX sh). One result line, `ezil-code-folder:<outcome>`, then
 * exit 0. The root may be a symlink the image itself made (it is the server's choice, not the ask);
 * every component below it is checked with -L before -e or -d, both of which follow symlinks.
 */
export const CODE_FOLDER_RESOLVE_SCRIPT = [
  'set -f',
  'say() { printf "ezil-code-folder:%s\\n" "$1"; exit 0; }',
  `r=\${${CODE_FOLDER_ROOT_ENV}-}`,
  `rel=\${${CODE_FOLDER_REL_ENV}-}`,
  'case $r in /*) ;; *) say error ;; esac',
  '[ -e "$r" ] || say missing',
  '[ -d "$r" ] || say not_directory',
  'p=${r%/}',
  'oldifs=$IFS; IFS=/',
  'set -- $rel',
  'IFS=$oldifs',
  'for c in "$@"; do',
  '  [ -n "$c" ] || say error',
  '  p=$p/$c',
  '  [ -L "$p" ] && say symlink',
  '  [ -e "$p" ] || say missing',
  '  [ -d "$p" ] || say not_directory',
  'done',
  'say restored',
].join('\n');

const RESULT_RE = /^ezil-code-folder:([a-z_]+)$/;

/** The walk's outcome from an exec result: exit 0 and exactly one known result line, else `error`. */
export function codeFolderWalkOutcome(exitCode: number, stdout: string | undefined): CodeFolderOutcome {
  if (exitCode !== 0 || typeof stdout !== 'string') return 'error';
  const lines = stdout.split('\n').filter((line, i, all) => !(line === '' && i === all.length - 1));
  if (lines.length !== 1) return 'error';
  const code = RESULT_RE.exec(lines[0]!)?.[1];
  return code !== undefined && (CODE_FOLDER_WALK_OUTCOMES as readonly string[]).includes(code) ? (code as CodeFolderOutcome) : 'error';
}

/**
 * The Cloudflare resolver for `settleCodeFolder`: one bounded exec of the constant script with the
 * root and `rel` in its env. Never throws (a refused or failed exec is `error`); stderr is never read.
 */
export function cloudflareCodeFolderResolver(exec: RepoOpenExec, root: string): CodeFolderResolver {
  return async (rel) => {
    try {
      const result = await exec(CODE_FOLDER_RESOLVE_SCRIPT, {
        env: { [CODE_FOLDER_ROOT_ENV]: root, [CODE_FOLDER_REL_ENV]: rel },
        timeout: CODE_FOLDER_RESOLVE_TIMEOUT_MS,
        origin: 'internal',
      });
      return codeFolderWalkOutcome(result.exitCode, result.stdout);
    } catch {
      return 'error';
    }
  };
}
