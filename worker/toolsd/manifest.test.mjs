/**
 * Manifest validation + catalog scan (contract section 4). `node:test`, so it
 * runs under `node --test` and under `bun test` from `worker/` (CI runs both).
 *
 * Every refusal asserts the EXACT closed-vocabulary error, and every refusal is
 * paired with a positive control proving the same manifest passes once the one
 * offending field is corrected — a test that only ever saw red would pass if
 * validateManifest rejected everything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateManifest, scanCatalog, canonicalize, catalogDigest,
  RESERVED_NAMES, MANIFEST_ERRORS, TOOLS_SUBPATH,
} from './manifest.mjs';

/** A minimal valid `ezil.tool/1` manifest for directory `name`. */
function base(name = 'hello', overrides = {}) {
  return {
    schema: 'ezil.tool/1',
    name,
    description: 'Say hello',
    inputSchema: { type: 'object', properties: {} },
    run: { argv: ['echo', 'hello'] },
    timeoutSeconds: 10,
    ...overrides,
  };
}

test('a valid manifest passes and yields the public ToolEntry plus argv', () => {
  const r = validateManifest(base('hello'), { dirName: 'hello' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tool, {
    name: 'hello',
    description: 'Say hello',
    inputSchema: { type: 'object', properties: {} },
    timeoutSeconds: 10,
    source: 'computer',
  });
  assert.deepEqual(r.argv, ['echo', 'hello']);
  assert.equal(r.argv0Kind, 'command');
});

test('every closed-vocabulary error is a known constant', () => {
  for (const e of ['manifest_too_large', 'manifest_unreadable', 'manifest_invalid_json',
    'manifest_schema', 'name_mismatch', 'name_reserved', 'argv_outside_tool', 'too_many_tools']) {
    assert.ok(MANIFEST_ERRORS.includes(e), `${e} is in the enum`);
  }
});

test('schema refusals: each field, with the untouched manifest passing as control', () => {
  // Control: the untouched base passes.
  assert.equal(validateManifest(base('tool_a'), { dirName: 'tool_a' }).ok, true);

  const schema = (overrides) => validateManifest(base('tool_a', overrides), { dirName: 'tool_a' });
  assert.equal(schema({ schema: 'ezil.tool/2' }).error, 'manifest_schema');
  assert.equal(schema({ description: '' }).error, 'manifest_schema');
  assert.equal(schema({ description: 'x'.repeat(1025) }).error, 'manifest_schema');
  assert.equal(schema({ inputSchema: { type: 'array' } }).error, 'manifest_schema');
  assert.equal(schema({ inputSchema: { type: 'object', big: 'x'.repeat(8300) } }).error, 'manifest_schema');
  assert.equal(schema({ timeoutSeconds: 0 }).error, 'manifest_schema');
  assert.equal(schema({ timeoutSeconds: 121 }).error, 'manifest_schema');
  assert.equal(schema({ timeoutSeconds: 1.5 }).error, 'manifest_schema');
  assert.equal(schema({ run: { argv: [] } }).error, 'manifest_schema');
  assert.equal(schema({ run: { argv: Array(33).fill('x') } }).error, 'manifest_schema');
  assert.equal(schema({ run: { argv: ['echo', 'x'.repeat(1025)] } }).error, 'manifest_schema');
  assert.equal(schema({ run: { argv: ['echo', 'a\0b'] } }).error, 'manifest_schema');
  assert.equal(schema({ run: { argv: ['echo'], extra: 1 } }).error, 'manifest_schema');
  // Positive control: timeout 120 and a single-arg bare command are both fine.
  assert.equal(schema({ timeoutSeconds: 120, run: { argv: ['true'] } }).ok, true);
});

test('unknown / missing keys are a schema refusal', () => {
  const withExtra = { ...base('tool_a'), extra: 1 };
  assert.equal(validateManifest(withExtra, { dirName: 'tool_a' }).error, 'manifest_schema');
  const { timeoutSeconds, ...missing } = base('tool_a');
  assert.equal(validateManifest(missing, { dirName: 'tool_a' }).error, 'manifest_schema');
  // Non-objects.
  assert.equal(validateManifest(null, { dirName: 'tool_a' }).error, 'manifest_schema');
  assert.equal(validateManifest([base('tool_a')], { dirName: 'tool_a' }).error, 'manifest_schema');
  assert.equal(validateManifest('x', { dirName: 'tool_a' }).error, 'manifest_schema');
});

test('name shape, mismatch and reservation are distinct refusals', () => {
  // Bad shape → schema (checked before identity/reservation).
  assert.equal(validateManifest(base('Hi'), { dirName: 'Hi' }).error, 'manifest_schema'); // uppercase + too short
  assert.equal(validateManifest(base('a'), { dirName: 'a' }).error, 'manifest_schema'); // too short
  assert.equal(validateManifest(base('1abc'), { dirName: '1abc' }).error, 'manifest_schema'); // leading digit
  // Well-formed name, wrong directory → mismatch.
  assert.equal(validateManifest(base('hello'), { dirName: 'goodbye' }).error, 'name_mismatch');
  // Well-formed name that is reserved → reserved (and it matches its dir).
  for (const reserved of ['whoami', 'open_computer', 'set_setting', 'browser_action']) {
    assert.ok(RESERVED_NAMES.has(reserved));
    assert.equal(validateManifest(base(reserved), { dirName: reserved }).error, 'name_reserved');
  }
  // Control: a near-reserved but distinct name passes.
  assert.equal(validateManifest(base('whoami2'), { dirName: 'whoami2' }).ok, true);
});

test('argv[0] forms: command, ./path (deferred) and the refused middle ground', () => {
  assert.equal(validateManifest(base('tool_a', { run: { argv: ['echo'] } }), { dirName: 'tool_a' }).argv0Kind, 'command');
  assert.equal(validateManifest(base('tool_a', { run: { argv: ['./run.sh'] } }), { dirName: 'tool_a' }).argv0Kind, 'path');
  // A relative path with a slash but no `./`, or an absolute path, is neither form.
  assert.equal(validateManifest(base('tool_a', { run: { argv: ['bin/run'] } }), { dirName: 'tool_a' }).error, 'manifest_schema');
  assert.equal(validateManifest(base('tool_a', { run: { argv: ['/usr/bin/env'] } }), { dirName: 'tool_a' }).error, 'manifest_schema');
});

test('name regex boundaries (48 chars ok, 49 not)', () => {
  const n48 = 'a' + 'b'.repeat(47);
  const n49 = 'a' + 'b'.repeat(48);
  assert.equal(validateManifest(base(n48), { dirName: n48 }).ok, true);
  assert.equal(validateManifest(base(n49), { dirName: n49 }).error, 'manifest_schema');
});

test('canonicalize sorts object keys recursively; array order preserved', () => {
  assert.deepEqual(
    Object.keys(canonicalize({ b: 1, a: { d: 1, c: 2 } })),
    ['a', 'b'],
  );
  assert.deepEqual(Object.keys(canonicalize({ b: 1, a: { d: 1, c: 2 } }).a), ['c', 'd']);
  assert.deepEqual(canonicalize([3, 1, 2]), [3, 1, 2]);
});

test('catalogDigest is stable under key reordering and order of the list', () => {
  const t1 = { name: 'a', description: 'd', inputSchema: { type: 'object', x: 1, y: 2 }, timeoutSeconds: 5, source: 'computer' };
  const t2 = { source: 'computer', timeoutSeconds: 5, inputSchema: { y: 2, type: 'object', x: 1 }, description: 'd', name: 'a' };
  assert.equal(catalogDigest([t1]), catalogDigest([t2]));
  const b = { name: 'b', description: 'd', inputSchema: { type: 'object' }, timeoutSeconds: 5, source: 'computer' };
  // Sorting by name means list order does not matter.
  assert.equal(catalogDigest([t1, b]), catalogDigest([b, t1]));
  // A different tool set is a different digest.
  assert.notEqual(catalogDigest([t1]), catalogDigest([t1, b]));
  assert.match(catalogDigest([]), /^sha256:[0-9a-f]{64}$/);
});

// ── scanCatalog: the filesystem half ────────────────────────────────────────

function withWorkspace(run) {
  const root = mkdtempSync(join(tmpdir(), 'ezil-toolsd-manifest-'));
  const toolsDir = join(root, TOOLS_SUBPATH);
  mkdirSync(toolsDir, { recursive: true });
  const addTool = (name, manifest, files = {}) => {
    const dir = join(toolsDir, name);
    mkdirSync(dir, { recursive: true });
    if (manifest !== undefined) {
      writeFileSync(join(dir, 'tool.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
    }
    for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content, { mode: 0o755 });
    return dir;
  };
  try {
    run({ root, toolsDir, addTool });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('scanCatalog: a missing .ezil/tools is an empty, well-formed catalog', () => {
  const root = mkdtempSync(join(tmpdir(), 'ezil-toolsd-empty-'));
  try {
    const c = scanCatalog(root);
    assert.deepEqual(c.tools, []);
    assert.deepEqual(c.invalid, []);
    assert.match(c.catalogDigest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scanCatalog: valid tools sorted by name, with an execution index', () => {
  withWorkspace(({ root, addTool }) => {
    addTool('zebra', base('zebra'));
    addTool('alpha', base('alpha', { run: { argv: ['./go.sh', '--x'] } }), { 'go.sh': '#!/bin/sh\necho hi\n' });
    const c = scanCatalog(root);
    assert.deepEqual(c.tools.map((t) => t.name), ['alpha', 'zebra']);
    assert.equal(c.invalid.length, 0);
    assert.equal(c.byName.get('alpha').argv[0], './go.sh');
    assert.ok(c.byName.get('alpha').dir.endsWith('/alpha'));
    assert.equal(c.byName.get('zebra').timeoutSeconds, 10);
  });
});

test('scanCatalog: file-level refusals each produce the right error', () => {
  withWorkspace(({ root, addTool }) => {
    addTool('good', base('good')); // positive control
    addTool('toobig', '{"schema":"ezil.tool/1"' + ' '.repeat(17000) + '}');
    addTool('badjson', '{ not json ');
    addTool('nomani', undefined); // directory, no tool.json
    addTool('mismatch', base('something_else')); // name != dir
    addTool('reserved', base('whoami')); // but dir is 'reserved' → mismatch wins (name 'whoami' != 'reserved')
    const c = scanCatalog(root);
    assert.deepEqual(c.tools.map((t) => t.name), ['good']);
    const byDir = Object.fromEntries(c.invalid.map((e) => [e.dir, e.error]));
    assert.equal(byDir.toobig, 'manifest_too_large');
    assert.equal(byDir.badjson, 'manifest_invalid_json');
    assert.equal(byDir.nomani, 'manifest_unreadable');
    assert.equal(byDir.mismatch, 'name_mismatch');
    assert.equal(byDir.reserved, 'name_mismatch');
  });
});

test('scanCatalog: name_reserved when the directory name itself is reserved', () => {
  withWorkspace(({ root, addTool }) => {
    addTool('settings', base('settings'));
    const c = scanCatalog(root);
    assert.equal(c.tools.length, 0);
    assert.equal(c.invalid[0].error, 'name_reserved');
  });
});

test('scanCatalog: ./argv[0] containment — inside ok, escape/missing refused', () => {
  withWorkspace(({ root, toolsDir, addTool }) => {
    // Inside: a real file within the tool dir.
    addTool('inside', base('inside', { run: { argv: ['./run.sh'] } }), { 'run.sh': '#!/bin/sh\n' });
    // Escape: a symlink pointing outside the tool dir.
    const escDir = addTool('escape', base('escape', { run: { argv: ['./out'] } }));
    symlinkSync('/bin/sh', join(escDir, 'out'));
    // Missing: a ./path that does not exist.
    addTool('missing', base('missing', { run: { argv: ['./nope'] } }));
    const c = scanCatalog(root);
    assert.ok(c.tools.map((t) => t.name).includes('inside'));
    const byDir = Object.fromEntries(c.invalid.map((e) => [e.dir, e.error]));
    assert.equal(byDir.escape, 'argv_outside_tool');
    assert.equal(byDir.missing, 'argv_outside_tool');
    assert.ok(!('toolsDir' in byDir)); // sanity: toolsDir var referenced
  });
});

test('scanCatalog: the 32-directory cap marks the rest too_many_tools', () => {
  withWorkspace(({ root, addTool }) => {
    // 40 valid tools, names zero-padded so sort order is deterministic.
    for (let i = 0; i < 40; i++) {
      const name = `tool_${String(i).padStart(3, '0')}`;
      addTool(name, base(name));
    }
    const c = scanCatalog(root);
    assert.equal(c.tools.length, 32);
    // The first 32 sorted names are read as tools; the rest are too_many_tools.
    assert.equal(c.tools[0].name, 'tool_000');
    assert.equal(c.tools[31].name, 'tool_031');
    assert.ok(c.invalid.length > 0 && c.invalid.length <= 32);
    assert.ok(c.invalid.every((e) => e.error === 'too_many_tools'));
    assert.equal(c.invalid[0].dir, 'tool_032');
  });
});

test('scanCatalog: a non-directory entry is not a tool', () => {
  withWorkspace(({ root, toolsDir, addTool }) => {
    addTool('real', base('real'));
    writeFileSync(join(toolsDir, 'README'), 'not a tool');
    const c = scanCatalog(root);
    assert.deepEqual(c.tools.map((t) => t.name), ['real']);
    assert.equal(c.invalid.length, 0);
  });
});
