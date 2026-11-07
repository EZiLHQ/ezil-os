/**
 * code-folder.ts — per-tab Code folder continuity, the Worker's LEXICAL half. Pure: no
 * filesystem, no network, no logging.
 *
 * A shell tab keeps the folder its own editor last reported (shell/ezil/apps/code-folder.js) and,
 * for its own files only, asks the next mint to reopen it: `codeFolder: {v:1, path}` in the
 * v2-signed `/sandbox/preview` body. That ask is a HINT, never authority:
 *   1. `planCodeFolder` checks it lexically, strips the SERVER's root (Cloudflare: the mounted
 *      `mountPath`, else CODE_FOLDER_UNMOUNTED_ROOT; AWS: `/workspace`), and refuses what is
 *      outside that root (`outside`) or belongs to EZiL or to a project (`not_allowed`);
 *   2. a resolver walks the remainder ON THE COMPUTER with no symlink followed. The resolver is
 *      not here: it is a Worker path-resolution addition, single writer e1cd418a
 *      (`code-folder-resolve.ts`, proposed). Until it is wired, every resolvable ask answers
 *      `unverified` and today's default folder opens;
 *   3. only a walked folder becomes the bootstrap's `folder=`, and only when the bootstrap URL
 *      stays within CODE_FOLDER_URL_MAX (`too_long` otherwise).
 * The answer carries `codeFolder: {v:1, outcome}`: a CODE, never a path. Anything but `restored`
 * opens today's per-provider default, and the shell says so visibly while keeping its record.
 *
 * Same grammar as the shell and the app: docs/contracts/code-folder-v1.vectors.json.
 */

/**
 * A Cloudflare computer's root when no workspace store is mounted: the container's own `WORKSPACE_ROOT`,
 * `start-neko.sh`'s default (index.ts `codePreviewFolderParams`).
 */
export const CODE_FOLDER_UNMOUNTED_ROOT = '/home/neko/project';
/** The longest folder path (UTF-8 bytes) any layer accepts. */
export const CODE_FOLDER_MAX_BYTES = 2048;
/**
 * A restored bootstrap URL longer than this is not used (`too_long`): the shell's frame confirmation accepts at
 * most 2048 characters (app `cloudflare-guacamole.ts` confirmFrame `frameUrl` `.max(2048)`), and the shell adds
 * `&ezil_mint=<22 chars>` to the minted URL.
 */
export const CODE_FOLDER_URL_MAX = 2000;
/** The shell's per-mint instance id on the bootstrap URL (shell/ezil/apps/code-folder.js MINT_PARAM). */
export const CODE_FOLDER_MINT_PARAM = 'ezil_mint';
/**
 * Keys code-server reads to choose what a document opens (`folder`, `workspace`, `ew`, `payload`), plus the
 * mint id. On a Code bootstrap they may only arrive as the bootstrap's OWN parameters, checked here, never
 * hidden inside its `path` (which is forwarded as given).
 */
export const CODE_BOOTSTRAP_PATH_REFUSED_KEYS = ['folder', 'workspace', 'ew', 'payload', CODE_FOLDER_MINT_PARAM] as const;

const MAX_SEGMENT_BYTES = 255;
const MAX_SEGMENTS = 64;
const MINT_RE = /^[A-Za-z0-9_-]{22}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** What the answer's `codeFolder.outcome` may say. Codes only, never a path. */
export const CODE_FOLDER_OUTCOMES = [
  'restored', 'missing', 'not_directory', 'symlink', 'outside', 'not_allowed', 'invalid', 'unverified', 'too_long', 'error',
] as const;
export type CodeFolderOutcome = (typeof CODE_FOLDER_OUTCOMES)[number];

/** No lone surrogate (String.prototype.isWellFormed is ES2024; this project's lib is ES2022). */
function wellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * A plain absolute POSIX folder path, normalised (one trailing `/` dropped), or null. No empty, `.` or `..`
 * segment, no control character, no backslash, no lone surrogate, at most 64 segments of at most 255 bytes and
 * 2048 bytes in all. Spaces and any well-formed Unicode are kept as they are (no NFC: a file name is bytes).
 */
export function plainFolderPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > CODE_FOLDER_MAX_BYTES) return null;
  if (!wellFormed(value)) return null;
  const path = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
  if (!path.startsWith('/') || utf8Bytes(path) > CODE_FOLDER_MAX_BYTES) return null;
  for (let i = 0; i < path.length; i += 1) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c === 0x7f || c === 0x5c) return null;
  }
  if (path === '/') return path;
  const segments = path.slice(1).split('/');
  if (segments.length > MAX_SEGMENTS) return null;
  return segments.every((s) => s !== '' && s !== '.' && s !== '..' && utf8Bytes(s) <= MAX_SEGMENT_BYTES) ? path : null;
}

/** `{v:1, path}` exactly (an unknown key, another version or a non-plain path is refused), else null. */
export function parseCodeFolderAsk(value: unknown): { path: string } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  // v1 has exactly two keys, so never sort more than that (the signed body is the app's rebuild, but the Worker
  // does not rely on it).
  const keys = Object.keys(value);
  if (keys.length !== 2 || keys.sort().join(',') !== 'path,v' || (value as { v?: unknown }).v !== 1) return null;
  const path = plainFolderPath((value as { path?: unknown }).path);
  return path ? { path } : null;
}

/** The shell's per-mint id when well formed (22 base64url characters), else null. */
export function codeFolderMint(value: string | null | undefined): string | null {
  return typeof value === 'string' && MINT_RE.test(value) ? value : null;
}

export type CodeFolderPlan =
  | { kind: 'none' }
  | { kind: 'refused'; outcome: CodeFolderOutcome }
  | { kind: 'resolve'; rel: string };

/**
 * What to walk, from an ask and the computer's root. `rel` is '' for the root itself.
 * - no ask -> `none` (today's default, byte for byte);
 * - a malformed ask or root -> `invalid`;
 * - outside the root -> `outside`;
 * - `.ezil/**` (EZiL's own state) or `projects/<uuid>/**` (a project's folder: its grant and its inert
 *   repository root belong to the project tab, never to an own-files tab) -> `not_allowed`.
 *   `projects/my-site` (not a uuid) is the person's own folder and is walked.
 */
export function planCodeFolder(ask: unknown, root: string): CodeFolderPlan {
  if (ask === undefined) return { kind: 'none' };
  const parsed = parseCodeFolderAsk(ask);
  const base = plainFolderPath(root);
  if (!parsed || !base) return { kind: 'refused', outcome: 'invalid' };
  const prefix = base === '/' ? '/' : `${base}/`;
  const rel = parsed.path === base ? '' : parsed.path.startsWith(prefix) ? parsed.path.slice(prefix.length) : null;
  if (rel === null) return { kind: 'refused', outcome: 'outside' };
  const [first, second] = rel.split('/');
  if (first === '.ezil' || (first === 'projects' && second !== undefined && UUID_RE.test(second))) {
    return { kind: 'refused', outcome: 'not_allowed' };
  }
  return { kind: 'resolve', rel };
}

/**
 * Walks `rel` below the root ON THE COMPUTER with no symlink followed, and answers a code (`restored` only for a
 * real directory every component of which is a real directory). Written by e1cd418a (`code-folder-resolve.ts`).
 */
export type CodeFolderResolver = (rel: string) => Promise<CodeFolderOutcome>;

/** One mint's folder decision: the outcome to answer (absent when nothing was asked) and the folder to open. */
export interface CodeFolderSettlement {
  outcome?: CodeFolderOutcome;
  /** Set only when the computer walked it (`restored`): `<root>/<rel>`, or the root itself. */
  folder?: string;
}

/**
 * Plan, then walk with `resolve` when one is wired. Never throws: a resolver failure is `error`, an unknown
 * resolver answer is `error`, and no resolver at all is `unverified`. Only `restored` yields a folder.
 */
export async function settleCodeFolder(ask: unknown, root: string, resolve?: CodeFolderResolver): Promise<CodeFolderSettlement> {
  const plan = planCodeFolder(ask, root);
  if (plan.kind === 'none') return {};
  if (plan.kind === 'refused') return { outcome: plan.outcome };
  if (!resolve) return { outcome: 'unverified' };
  let outcome: CodeFolderOutcome;
  try {
    const answered = await resolve(plan.rel);
    outcome = (CODE_FOLDER_OUTCOMES as readonly string[]).includes(answered) ? answered : 'error';
  } catch {
    outcome = 'error';
  }
  if (outcome !== 'restored') return { outcome };
  const base = plainFolderPath(root)!;
  return { outcome, folder: plan.rel === '' ? base : `${base === '/' ? '' : base}/${plan.rel}` };
}

/** Whether a bootstrap URL that opens a restored folder still fits the shell's frame confirmation. */
export function fitsCodeFolderUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && url.length <= CODE_FOLDER_URL_MAX;
}

/** The first key of `CODE_BOOTSTRAP_PATH_REFUSED_KEYS` present in `search`, or null. */
export function codeBootstrapPathProblem(search: URLSearchParams): string | null {
  return CODE_BOOTSTRAP_PATH_REFUSED_KEYS.find((k) => search.has(k)) ?? null;
}

/** The answer field: `{v:1, outcome}` when something was asked, else nothing. */
export function codeFolderAnswer(outcome: CodeFolderOutcome | undefined): { codeFolder?: { v: 1; outcome: CodeFolderOutcome } } {
  return outcome ? { codeFolder: { v: 1, outcome } } : {};
}
