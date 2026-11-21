/**
 * `ezil.tool/1` manifest validation and catalog scan (frozen contract section 4).
 *
 * Two exports, and the split is deliberate:
 *   - `validateManifest(value, { dirName })` is PURE: it decides everything a
 *     manifest can be refused for by looking only at the parsed value and the
 *     directory name. No filesystem, no clock, no randomness. This is the half
 *     `ezil tool validate` runs offline from `/opt/ezil-toolsd/manifest.mjs`,
 *     and the half a unit test can exhaust without a disk.
 *   - `scanCatalog(workspaceRoot)` adds exactly the filesystem: it lists the
 *     tool directories, reads each `tool.json`, and performs the ONE check that
 *     genuinely needs the disk — the realpath containment of a `./`-form
 *     `argv[0]` inside its own tool directory. Everything else it delegates to
 *     `validateManifest`.
 *
 * The error vocabulary is closed (`MANIFEST_ERRORS`); a reader can see at a
 * glance that no exception's own text ever leaks into an `invalid` entry.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

/** `EZIL_WORKSPACE_ROOT` default (contract section 4); also the start-neko default. */
export const DEFAULT_WORKSPACE_ROOT = '/home/neko/project';

/** `<workspace>/.ezil/tools` — where self-built tools live. */
export const TOOLS_SUBPATH = '.ezil/tools';

export const MAX_MANIFEST_BYTES = 16_384;
export const MAX_INPUT_SCHEMA_BYTES = 8_192;
export const MAX_TOOLS = 32;
export const MAX_ARGV = 32;
export const MAX_ARGV_STRING = 1_024;
export const MAX_DESCRIPTION = 1_024;

/** `^[a-z][a-z0-9_]{2,47}$`: 3–48 chars, leading letter. Equals the directory name. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{2,47}$/;

/** The one closed set of refusal reasons. Nothing else is ever emitted. */
export const MANIFEST_ERRORS = [
  'manifest_too_large',
  'manifest_unreadable',
  'manifest_invalid_json',
  'manifest_schema',
  'name_mismatch',
  'name_reserved',
  'argv_outside_tool',
  'too_many_tools',
];

/**
 * Reserved tool names (contract section 4). A self-built tool may not shadow a
 * platform tool name, so the dispatcher's namespace stays unambiguous. Frozen
 * list — pasted verbatim from the contract.
 */
export const RESERVED_NAMES = new Set([
  'whoami', 'list_computers', 'get_computer', 'list_sessions', 'get_session', 'read_session',
  'get_instruction', 'send_instruction', 'cancel_instruction', 'start_computer', 'list_models',
  'create_session', 'get_session_settings', 'configure_session', 'get_control', 'open_computer',
  'observe_browser_session', 'browser_open_url', 'create_native_session', 'renew_native_session',
  'get_native_authorization', 'get_native_session', 'read_native_session', 'get_native_prompt',
  'get_native_operation', 'send_native_instruction', 'answer_native_prompt', 'cancel_native_operation',
  'create_computer', 'settings', 'browser_read_page', 'browser_action', 'list_computer_tools',
  'call_computer_tool', 'refresh_computer_tools', 'run_terminal_command', 'get_terminal_job',
  'cancel_terminal_job', 'set_setting',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const fail = (error) => ({ ok: false, error });

/**
 * Validate one parsed manifest value against `ezil.tool/1`. Pure: the realpath
 * containment of a `./`-form `argv[0]` is NOT decided here (it needs the disk)
 * — the form is checked, and `scanCatalog` resolves it.
 *
 * Returns `{ ok:true, tool, argv }` where `tool` is the public `ToolEntry`
 * (`{ name, description, inputSchema, timeoutSeconds, source:'computer' }`) and
 * `argv` is the validated `run.argv` the job runner needs, or `{ ok:false, error }`.
 */
export function validateManifest(value, { dirName } = {}) {
  if (!isPlainObject(value)) return fail('manifest_schema');

  // Exactly these keys, nothing more, nothing missing.
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'description,inputSchema,name,run,schema,timeoutSeconds') return fail('manifest_schema');

  if (value.schema !== 'ezil.tool/1') return fail('manifest_schema');

  // name: shape first, then identity (mismatch), then reservation.
  const { name } = value;
  if (typeof name !== 'string' || !TOOL_NAME_RE.test(name)) return fail('manifest_schema');
  if (typeof dirName === 'string' && name !== dirName) return fail('name_mismatch');
  if (RESERVED_NAMES.has(name)) return fail('name_reserved');

  const { description } = value;
  if (typeof description !== 'string' || description.length < 1 || description.length > MAX_DESCRIPTION) {
    return fail('manifest_schema');
  }

  const { inputSchema } = value;
  if (!isPlainObject(inputSchema) || inputSchema.type !== 'object') return fail('manifest_schema');
  // Advisory, but its serialized size is bounded so the catalog cannot be bloated.
  let inputSchemaBytes;
  try {
    inputSchemaBytes = Buffer.byteLength(JSON.stringify(inputSchema), 'utf8');
  } catch {
    return fail('manifest_schema'); // non-serializable (e.g. a cycle)
  }
  if (inputSchemaBytes > MAX_INPUT_SCHEMA_BYTES) return fail('manifest_schema');

  const { timeoutSeconds } = value;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) return fail('manifest_schema');

  const { run } = value;
  if (!isPlainObject(run) || Object.keys(run).join(',') !== 'argv') return fail('manifest_schema');
  const { argv } = run;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGV) return fail('manifest_schema');
  for (const arg of argv) {
    if (typeof arg !== 'string' || arg.length < 1 || arg.length > MAX_ARGV_STRING || arg.includes('\0')) {
      return fail('manifest_schema');
    }
  }

  // argv[0] must be one of the two sanctioned forms. A bare command name (no
  // slash) is a PATH lookup; a `./`-prefixed path is resolved inside the tool
  // directory (containment decided on disk by scanCatalog). Any other shape —
  // absolute, `../`, or a bare relative path with a slash — is not a form the
  // contract admits, and is a schema violation, not a containment one.
  const argv0 = argv[0];
  const argv0Kind = argv0.startsWith('./') ? 'path' : (argv0.includes('/') ? 'invalid' : 'command');
  if (argv0Kind === 'invalid') return fail('manifest_schema');

  const tool = {
    name,
    description,
    inputSchema,
    timeoutSeconds,
    source: 'computer',
  };
  return { ok: true, tool, argv, argv0Kind };
}

/**
 * Canonical JSON: object keys sorted recursively, arrays left in order. The
 * catalog digest must be stable regardless of the key order a manifest author
 * happened to write (especially inside `inputSchema`).
 */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/** Byte-stable lexicographic order used for both the directory scan and the digest. */
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * `catalogDigest` = `"sha256:" + hex(SHA-256(JSON of the valid ToolEntry list
 * sorted by name, keys sorted))` (contract section 4). The canonical form is
 * what makes two scans of the same tools agree byte for byte.
 */
export function catalogDigest(tools) {
  const sorted = tools.slice().sort((a, b) => byName(a.name, b.name)).map(canonicalize);
  const hex = createHash('sha256').update(JSON.stringify(sorted), 'utf8').digest('hex');
  return `sha256:${hex}`;
}

/**
 * Read `<workspace>/.ezil/tools`, validate every tool directory in sorted
 * order, and return the `Catalog` plus a private execution index (`byName`,
 * `name -> { argv, dir, timeoutSeconds }`) the job runner uses. `byName` is NOT
 * part of the wire `Catalog`; the server serialises `{ catalogDigest, tools,
 * invalid }` explicitly.
 *
 * Caps (contract sections 2.2 / 4): at most 32 directories are read, sorted by
 * name; every directory beyond the 32nd is `too_many_tools`; the wire `invalid`
 * list is itself bounded to 32.
 */
export function scanCatalog(workspaceRoot = DEFAULT_WORKSPACE_ROOT) {
  const toolsDir = join(workspaceRoot, TOOLS_SUBPATH);
  const tools = [];
  const invalid = [];
  const execByName = new Map();

  let entries;
  try {
    entries = readdirSync(toolsDir, { withFileTypes: true });
  } catch {
    // No `.ezil/tools` yet (or unreadable): an empty, well-formed catalog.
    return { catalogDigest: catalogDigest([]), tools, invalid, byName: execByName };
  }

  // Only REAL directories are tool directories. `withFileTypes` does not follow
  // symlinks, so a symlinked entry is skipped rather than silently followed.
  const dirNames = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort(byName);

  for (let i = 0; i < dirNames.length; i++) {
    const dir = dirNames[i];
    if (i >= MAX_TOOLS) {
      if (invalid.length < MAX_TOOLS) invalid.push({ dir, error: 'too_many_tools' });
      continue;
    }

    const manifestPath = join(toolsDir, dir, 'tool.json');
    let size;
    try {
      size = statSync(manifestPath).size;
    } catch {
      invalid.push({ dir, error: 'manifest_unreadable' });
      continue;
    }
    if (size > MAX_MANIFEST_BYTES) { invalid.push({ dir, error: 'manifest_too_large' }); continue; }

    let text;
    try {
      text = readFileSync(manifestPath, 'utf8');
    } catch {
      invalid.push({ dir, error: 'manifest_unreadable' });
      continue;
    }
    // Belt and braces: a file that grew between stat and read is still bounded.
    if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) { invalid.push({ dir, error: 'manifest_too_large' }); continue; }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      invalid.push({ dir, error: 'manifest_invalid_json' });
      continue;
    }

    const result = validateManifest(parsed, { dirName: dir });
    if (!result.ok) { invalid.push({ dir, error: result.error }); continue; }

    // The one on-disk check: a `./`-form argv[0] must realpath to a file strictly
    // inside this tool's own directory. A bare command name is a PATH lookup and
    // is resolved by the OS at exec time, not here.
    if (result.argv0Kind === 'path') {
      let contained = false;
      try {
        const toolDirReal = realpathSync(join(toolsDir, dir));
        const resolved = realpathSync(resolve(toolDirReal, result.argv[0]));
        contained = resolved !== toolDirReal && resolved.startsWith(toolDirReal + sep);
      } catch {
        contained = false;
      }
      if (!contained) { invalid.push({ dir, error: 'argv_outside_tool' }); continue; }
    }

    tools.push(result.tool);
    execByName.set(result.tool.name, {
      argv: result.argv,
      dir: join(toolsDir, dir),
      timeoutSeconds: result.tool.timeoutSeconds,
    });
  }

  return {
    catalogDigest: catalogDigest(tools),
    tools,
    invalid: invalid.slice(0, MAX_TOOLS),
    byName: execByName,
  };
}
