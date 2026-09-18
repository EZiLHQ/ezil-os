'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { builtinModules } = require('node:module');
const { privateDir, atomic } = require('../src/files.cjs');
const { cleanEnvironment } = require('../src/vscode.cjs');
const { hashes } = require('../src/connector.cjs');
function checkClosure(metadata) {
  for (const output of Object.values(metadata.outputs || {})) for (const item of output.imports || []) {
    if (item.external && !(item.path === 'bun' || item.path.startsWith('node:') || builtinModules.includes(item.path))) throw Error('Unbundled helper dependency');
  }
  if (!Object.keys(metadata.inputs || {}).length || !Object.keys(metadata.outputs || {}).length) throw Error('Missing bundle metadata');
}
function bundleHelper(bun, source, resources) {
  const destination = path.join(resources, 'native');
  fs.rmSync(destination, { recursive: true, force: true });
  const output = path.join(privateDir(path.join(destination, 'src')), 'helper.js');
  const metadataPath = path.join(destination, 'closure.json');
  execFileSync(bun, ['build', '--no-env-file', '--target=bun', '--format=esm', '--packages=bundle', '--reject-unresolved', '--env=disable', `--outfile=${output}`, `--metafile=${metadataPath}`, path.join(source, 'src/main.ts')], { cwd: resources, env: cleanEnvironment(), stdio: 'inherit' });
  const metadata = JSON.parse(fs.readFileSync(metadataPath)); checkClosure(metadata);
  // Retain dependency hashes, not absolute build-machine paths.
  const inputs = Object.keys(metadata.inputs).map(file => ({ name: path.relative(path.dirname(source), path.resolve(resources, file)), bytes: metadata.inputs[file].bytes, sha256: createHash('sha256').update(fs.readFileSync(path.resolve(resources, file))).digest('hex') }));
  atomic(metadataPath, JSON.stringify({ version: 1, inputs, external: [...new Set(Object.values(metadata.outputs).flatMap(o => (o.imports || []).filter(i => i.external).map(i => i.path)))], dependencyComplete: true }, null, 2));
  atomic(path.join(destination, 'package.json'), JSON.stringify({ type: 'module', private: true }));
  return { path: 'native', files: hashes(destination) };
}
module.exports = { bundleHelper, checkClosure };
