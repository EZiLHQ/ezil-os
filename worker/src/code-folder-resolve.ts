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
 * split on `/` uses a local IFS (a glob would otherwise match against the shell's working directory,
 * which may be the root itself). Every tested path is absolute, so a name starting with `-` is
 * never read as an option. The walk runs inside the Code mint, so the exec is bounded by
 * CODE_FOLDER_RESOLVE_TIMEOUT_MS and the whole resolve by CODE_FOLDER_RESOLVE_BOUND_MS.
 *
 * Trust: the walk runs in the person's own container and reports to that person's own mint, so a
 * result the container's root could shape changes only which of their own folders opens. A folder
 * swapped for a symlink or a bind mount after the walk is that same person's act (residual).
 *
 * AWS (`awsCodeFolderResolver`): the same walk on the HOST, below `<dataMount>/workspace`, by the host
 * edge's `folder` op (host-agent `edge.py` `_folder`, `fsops.classify_dir_below`): one gw1-signed POST to
 * the tunnel record's own origin, the body's sha256 in the signed path, a code back, never the path.
 */
import {
  AWS_GATEWAY_HEADER,
  awsOriginHostname,
  decodeControlKey,
  signGatewayHeader,
  type AwsTunnelRecord,
  type FetchLike,
} from './aws-origin';
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
 * The whole resolve, whatever the exec does: a container that never answers, or an SDK call that
 * ignores its own timeout, still settles as `error` by then, so the Code mint is never held longer.
 */
export const CODE_FOLDER_RESOLVE_BOUND_MS = CODE_FOLDER_RESOLVE_TIMEOUT_MS + 1_000;

/**
 * What the Cloudflare exec runs: the walk inside a subshell. The Sandbox SDK runs a foreground exec in the
 * session's OWN shell (its persistent `bash --norc`, inside `{ …; EXIT_CODE=$? }`), so the script's `exit`
 * (every `say`) ended that shared shell, and the desktop stack started in the same session died with it: live
 * 2026-11-05, every later Code mint on that computer failed with relay_refresh_failed. The subshell also keeps
 * the walk's `set -f`, IFS and positional parameters out of the session. The SDK's per-command env is inherited.
 */
export const CODE_FOLDER_RESOLVE_COMMAND = `(\n${CODE_FOLDER_RESOLVE_SCRIPT}\n)`;

/**
 * The Cloudflare resolver for `settleCodeFolder`: one exec of the constant command with the root and
 * `rel` in its env, the exec bounded by CODE_FOLDER_RESOLVE_TIMEOUT_MS and the whole call by
 * `boundMs`. Never throws (a refused, failed or late exec is `error`); stderr is never read.
 */
export function cloudflareCodeFolderResolver(exec: RepoOpenExec, root: string, boundMs = CODE_FOLDER_RESOLVE_BOUND_MS): CodeFolderResolver {
  return async (rel) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<CodeFolderOutcome>((resolve) => { timer = setTimeout(() => resolve('error'), boundMs); });
    const walked = (async (): Promise<CodeFolderOutcome> => {
      try {
        const result = await exec(CODE_FOLDER_RESOLVE_COMMAND, {
          env: { [CODE_FOLDER_ROOT_ENV]: root, [CODE_FOLDER_REL_ENV]: rel },
          timeout: CODE_FOLDER_RESOLVE_TIMEOUT_MS,
          origin: 'internal',
        });
        return codeFolderWalkOutcome(result.exitCode, result.stdout);
      } catch {
        return 'error';
      }
    })();
    try {
      return await Promise.race([walked, late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}

/** The host edge's folder op: `POST <this>/<sha256hex(body)>`, nothing else in the path, no query. */
export const AWS_CODE_FOLDER_CONTROL_PATH = '/__ezil/control/folder';
/** The host's `result` (`fsops.classify_dir_below`) → the walk's code. `bad_path` and anything else are `error`. */
const AWS_FOLDER_RESULTS: Readonly<Record<string, CodeFolderOutcome>> = {
  ok: 'restored', missing: 'missing', not_directory: 'not_directory', symlink: 'symlink',
};
/** The host's whole answer is `{"ok": true, "result": "not_directory"}`; anything longer is not one. */
const AWS_FOLDER_ANSWER_MAX_BYTES = 256;

/**
 * The op's exact body bytes, built ONCE (this key order, no whitespace): the gw1 signature covers the
 * path only, so the body's sha256 travels in the signed path and the host hashes the bytes it read
 * before parsing them. Never re-serialize between hashing and sending.
 */
export function awsCodeFolderBody(rel: string): string {
  return JSON.stringify({ v: 1, rel });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The host's answer → the walk's code: 200 with exactly `{ok: true, result}` and a known result; 404 is an
 * agent without the op (an AMI from before it), which is `unverified` exactly as with no resolver; anything
 * else (a refused body or signature, a 5xx, a redirect, an odd body) is `error`. The body is never echoed.
 */
export async function awsCodeFolderOutcome(res: Response): Promise<CodeFolderOutcome> {
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return 'unverified';
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return 'error';
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > AWS_FOLDER_ANSWER_MAX_BYTES) return 'error';
  let answer: unknown;
  try { answer = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return 'error'; }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) return 'error';
  const { ok, result } = answer as { ok?: unknown; result?: unknown };
  if (Object.keys(answer).sort().join(',') !== 'ok,result' || ok !== true || typeof result !== 'string') return 'error';
  return Object.hasOwn(AWS_FOLDER_RESULTS, result) ? AWS_FOLDER_RESULTS[result]! : 'error';
}

/**
 * The AWS resolver for `handleAwsPreview`'s `resolveFolder`: one gw1-signed POST of `{"v":1,"rel":…}` to the
 * record's own origin (its generation and lease epoch name the host, so an earlier host never answers), the
 * request bounded by CODE_FOLDER_RESOLVE_TIMEOUT_MS and the whole call by `boundMs`. Never throws: a record
 * without a usable control key, a refused fetch or a late host is `error`.
 */
export function awsCodeFolderResolver(
  zone: string,
  fetchFn: FetchLike,
  nowMs: () => number,
  boundMs = CODE_FOLDER_RESOLVE_BOUND_MS,
): (record: AwsTunnelRecord, rel: string) => Promise<CodeFolderOutcome> {
  return async (record, rel) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<CodeFolderOutcome>((resolve) => { timer = setTimeout(() => resolve('error'), boundMs); });
    const walked = (async (): Promise<CodeFolderOutcome> => {
      try {
        const key = decodeControlKey(record.controlKey);
        if (!key) return 'error';
        const body = awsCodeFolderBody(rel);
        const path = `${AWS_CODE_FOLDER_CONTROL_PATH}/${await sha256Hex(body)}`;
        const host = awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, zone);
        const header = await signGatewayHeader(key, record, 'POST', path, Math.floor(nowMs() / 1000));
        const res = await fetchFn(`https://${host}${path}`, {
          method: 'POST', headers: { [AWS_GATEWAY_HEADER]: header, 'content-type': 'application/json' }, body,
          redirect: 'manual', signal: AbortSignal.timeout(CODE_FOLDER_RESOLVE_TIMEOUT_MS),
        });
        return await awsCodeFolderOutcome(res);
      } catch {
        return 'error';
      }
    })();
    try {
      return await Promise.race([walked, late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
}
