'use strict';
// Standalone, read-only verification: no checkout imports, subprocesses, network,
// environment discovery, or execution of the bundle being inspected.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { builtinModules } = require('node:module');
const BUNDLE_PINS = Object.freeze({ bun: '1.3.14', editor: '4.137.0', editorArchiveSHA256: '118604a8245816535d8e538f478d2ee93514bcb8ac75e210d2345a5dc7806f65', architecture: 'arm64' });
const builtins = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code) { const error = new Error(code); error.code = code; throw error; }
function relativeFile(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) fail('bundle_invalid_relative_path');
  const normalized = value.replace(/^\.\//, '');
  if (normalized.split('/').some(part => !part || part === '.' || part === '..')) fail('bundle_invalid_relative_path');
  return normalized;
}
function digest(file) {
  const hash = createHash('sha256'), fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(1024 * 1024); let bytes;
    while ((bytes = fs.readSync(fd, buffer))) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
/**
 * verifyRuntimeBundle(resources, inventory?) -> compact, path-free evidence.
 * Before signing: pass package.cjs's inventory object (including codeServer and
 * inputs.helper). Otherwise Resources/INVENTORY.json supplies the same evidence.
 * Hashes describe pre-sign bytes. Re-run with refreshed evidence after signing.
 * This verifies layout/build evidence, not signatures or runtime behavior.
 */
function verifyRuntimeBundle(resources, inventory) {
  try {
    if (typeof resources !== 'string' || !path.isAbsolute(resources)) fail('bundle_invalid_root');
    const root = fs.realpathSync(resources);
    if (!fs.statSync(root).isDirectory()) fail('bundle_invalid_root');
    const inside = file => {
      const relative = path.relative(root, file);
      return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    let files = 0, directories = 0, symlinks = 0, bytes = 0, entries = 0;
    function visit(directory, depth) {
      if (depth > 128) fail('bundle_tree_limit');
      directories++;
      for (const name of fs.readdirSync(directory).sort()) {
        if (++entries > 250000) fail('bundle_tree_limit');
        const file = path.join(directory, name), stat = fs.lstatSync(file);
        if (stat.isSymbolicLink()) {
          let target;
          try { target = fs.realpathSync(file); } catch { fail('bundle_broken_symlink'); }
          if (!inside(target)) fail('bundle_external_symlink');
          // Absolute internal links work only at the staging location, not after
          // moving the app. Relative internal links, including ../, are valid.
          if (path.isAbsolute(fs.readlinkSync(file))) fail('bundle_nonportable_symlink');
          symlinks++;
        } else if (stat.isDirectory()) visit(file, depth + 1);
        else if (stat.isFile()) { files++; bytes += stat.size; }
        else fail('bundle_special_file');
      }
    }
    visit(root, 0);
    function required(relative, executable = false) {
      const file = path.join(root, relativeFile(relative));
      let stat;
      try { stat = fs.statSync(file); } catch { fail('bundle_missing_file'); }
      if (!stat.isFile() || stat.size === 0) fail('bundle_missing_file');
      if (!inside(fs.realpathSync(file))) fail('bundle_external_symlink');
      if (executable && !(stat.mode & 0o111)) fail('bundle_not_executable');
      return file;
    }
    function json(relative) {
      const file = required(relative);
      if (fs.statSync(file).size > 32 * 1024 * 1024) fail('bundle_metadata_limit');
      try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('bundle_invalid_metadata'); }
    }
    const editor = required('code-server/bin/code-server', true), node = required('code-server/lib/node', true), bun = required('bun/bun', true);
    required('code-server/out/node/entry.js'); required('code-server/lib/vscode/package.json');
    const editorPackage = json('code-server/package.json');
    if (editorPackage.version !== BUNDLE_PINS.editor) fail('bundle_editor_pin_mismatch');
    const helper = required('native/src/helper.js'), closure = json('native/closure.json');
    if (!object(closure) || closure.version !== 1 || closure.dependencyComplete !== true || !Array.isArray(closure.inputs) || !closure.inputs.length || !Array.isArray(closure.external)) fail('bundle_helper_not_closed');
    for (const input of closure.inputs) {
      // Input names are provenance, never paths to open on the build machine.
      if (!object(input) || typeof input.name !== 'string' || !input.name || path.isAbsolute(input.name) || /^[A-Za-z]:/.test(input.name) || !sha(input.sha256) || !Number.isSafeInteger(input.bytes) || input.bytes < 0) fail('bundle_invalid_closure');
    }
    for (const external of closure.external) if (typeof external !== 'string' || (external !== 'bun' && !builtins.has(external.replace(/^node:/, '')))) fail('bundle_helper_external_dependency');
    if (json('native/package.json').type !== 'module') fail('bundle_invalid_helper_package');
    for (const asset of ['bundle.min.js', 'bundle.min.css', 'icons.js']) required(`app/public/os/${asset}`);
    const connectorPackage = json('extensions/ezil-vscode/package.json');
    if (!object(connectorPackage) || !connectorPackage.name || !connectorPackage.version || !connectorPackage.engines?.vscode) fail('bundle_invalid_connector');
    const connector = required(`extensions/ezil-vscode/${relativeFile(connectorPackage.main)}`);
    const metadata = inventory === undefined ? json('INVENTORY.json') : inventory;
    if (!object(metadata) || metadata.bun !== BUNDLE_PINS.bun) fail('bundle_bun_pin_mismatch');
    const code = metadata.codeServer;
    if (!object(code) || code.version !== BUNDLE_PINS.editor || code.archiveSHA256 !== BUNDLE_PINS.editorArchiveSHA256 || code.architecture !== BUNDLE_PINS.architecture) fail('bundle_editor_pin_mismatch');
    if (!Array.isArray(code.nativeFiles) || !code.nativeFiles.includes('lib/node') || !Array.isArray(code.licenses) || !code.licenses.length) fail('bundle_invalid_editor_inventory');
    // Mach-O objects/addons are inventoried too; dlopen does not require their
    // executable mode bit. The three actual launch executables are checked above.
    for (const file of code.nativeFiles) required(`code-server/${relativeFile(file)}`);
    for (const file of code.licenses) required(`code-server/${relativeFile(file)}`);
    const evidence = metadata.inputs?.helper;
    if (!object(evidence) || evidence.path !== 'native' || !object(evidence.files)) fail('bundle_missing_helper_evidence');
    for (const file of ['src/helper.js', 'closure.json', 'package.json']) if (!sha(evidence.files[file])) fail('bundle_missing_helper_evidence');
    for (const [relative, expected] of Object.entries(evidence.files)) {
      if (!sha(expected) || digest(required(`native/${relativeFile(relative)}`)) !== expected) fail('bundle_helper_hash_mismatch');
    }
    return {
      schemaVersion: 1, architecture: BUNDLE_PINS.architecture, codeServerVersion: BUNDLE_PINS.editor, bunVersion: BUNDLE_PINS.bun,
      files, directories, symlinks, bytes, helperDependencyClosed: true, helperInputs: closure.inputs.length,
      sha256: { editorLauncher: digest(editor), editorNode: digest(node), bun: digest(bun), helper: digest(helper), helperClosure: digest(required('native/closure.json')), connector: digest(connector) },
    };
  } catch (error) {
    // Never leak filesystem locations, JSON contents, OS errors, or causes.
    if (typeof error?.code === 'string' && /^bundle_[a-z_]+$/.test(error.code)) throw error;
    fail('bundle_unreadable');
  }
}
module.exports = { verifyRuntimeBundle, BUNDLE_PINS };
