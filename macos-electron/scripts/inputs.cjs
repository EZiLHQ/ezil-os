'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { copyTree, privateDir, noLinks } = require('../src/files.cjs');
const { hashes, validateExtension } = require('../src/connector.cjs');
const excluded = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|node_modules|\.git)$/i;
function helperCopy(source, dest) {
  noLinks(source);
  privateDir(dest);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (excluded.test(entry.name)) continue;
    if (entry.isSymbolicLink()) throw Error('Helper symlink refused');
    if (entry.isDirectory()) helperCopy(path.join(source, entry.name), path.join(dest, entry.name));
    else if (entry.isFile()) {
      const from = path.join(source, entry.name), to = path.join(dest, entry.name);
      if (fs.lstatSync(from).nlink !== 1) throw Error('Helper hardlink refused');
      const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const before = hash(from);
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      if (hash(to) !== before) throw Error('Packaged helper mismatch');
    }
    else throw Error('Helper special file refused');
  }
}
function hashedCopy(source, dest, inventory) {
  noLinks(source); privateDir(dest);
  const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  for (const [relative, expected] of Object.entries(inventory)) {
    const from = path.join(source, relative), to = path.join(dest, relative);
    noLinks(from); privateDir(path.dirname(to));
    const stat = fs.lstatSync(from);
    if (!stat.isFile() || stat.nlink !== 1 || hash(from) !== expected) throw Error('Runtime input changed');
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    if (hash(to) !== expected) throw Error('Packaged input mismatch');
  }
}
function validateInputs({ helper, shell, extension }) {
  for (const file of [path.join(helper, 'src/main.ts'), ...['bundle.min.js', 'bundle.min.css', 'icons.js'].map(name => path.join(shell, name))]) {
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw Error('Missing exact shell assets/native helper');
  }
  validateExtension(extension);
}
function stageInputs(inputs, resources) {
  validateInputs(inputs);
  const destinations = { helper: 'native', shell: 'app/public/os', extension: 'extensions/ezil-vscode' };
  const result = {};
  for (const [key, relative] of Object.entries(destinations)) {
    const source = inputs[key], dest = path.join(resources, relative);
    if (key === 'helper') helperCopy(source, dest);
    else if (key === 'extension') {
      const before = hashes(source);
      hashedCopy(source, dest, before);
      if (JSON.stringify(before) !== JSON.stringify(hashes(dest))) throw Error('Packaged input mismatch');
    }
    else {
      const before = hashes(source);
      copyTree(source, dest);
      if (JSON.stringify(before) !== JSON.stringify(hashes(dest))) throw Error('Packaged input mismatch');
    }
    result[key] = { path: relative, files: hashes(dest) };
  }
  return result;
}
module.exports = { validateInputs, stageInputs };
