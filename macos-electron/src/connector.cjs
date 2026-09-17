'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { treeInventory, copyTree, removeInventory, privateDir, noLinks } = require('./files.cjs');
// No connector descriptor is created until the helper mint/revoke API and
// extension's short-lived refresh protocol can be verified together. Never
// substitute the models/chat AI broker descriptor for this protocol.
const connectorStatus = Object.freeze({ readiness: 'unavailable', preview: 'unavailable', modelProvider: 'unavailable' });
const forbidden = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|\.git)$/i;
function hashes(root) {
  const entries = treeInventory(root);
  if (entries.some(entry => path.relative(root, entry.file).split(path.sep).some(part => forbidden.test(part)))) throw Error('Private files in runtime input');
  return Object.fromEntries(entries.filter(entry => !entry.directory).map(entry => [path.relative(root, entry.file), createHash('sha256').update(fs.readFileSync(entry.file)).digest('hex')]));
}
function validateExtension(source) {
  const inventory = hashes(source);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (!pkg.name || !pkg.version || !pkg.engines?.vscode || typeof pkg.main !== 'string' || path.isAbsolute(pkg.main) || pkg.main.split(/[\\/]/).includes('..') || !inventory[path.normalize(pkg.main)]) throw Error('Missing runnable connector extension');
  return inventory;
}
function installConnector(source, workspace) {
  // Only the fixed connector directory in this workspace's dedicated profile
  // is managed; the user's global extensions and other workspaces are untouched.
  const expected = validateExtension(source);
  const destination = path.join(privateDir(workspace.extensions), 'ezil-vscode');
  noLinks(destination);
  if (fs.existsSync(destination)) {
    if (JSON.stringify(hashes(destination)) === JSON.stringify(expected)) return destination;
    removeInventory(treeInventory(destination));
  }
  copyTree(source, destination);
  if (JSON.stringify(hashes(destination)) !== JSON.stringify(expected)) throw Error('Connector copy mismatch');
  return destination;
}
module.exports = { connectorStatus, hashes, validateExtension, installConnector };
