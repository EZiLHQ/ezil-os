'use strict';
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { cleanEnvironment } = require('./vscode.cjs');
function discoverXcode({ platform = process.platform, run = childProcess.execFileSync } = {}) {
  const result = { available: false, version: null, developerDir: null, swift: null, metal: null };
  if (platform !== 'darwin') return result;
  const invoke = (file, args) => run(file, args, { env: cleanEnvironment(), encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    result.developerDir = invoke('/usr/bin/xcode-select', ['-p']);
    result.version = invoke('/usr/bin/xcodebuild', ['-version']);
    result.available = /^Xcode \d/m.test(result.version) && path.isAbsolute(result.developerDir) && result.developerDir.endsWith('.app/Contents/Developer');
  } catch { /* Command Line Tools alone are not full Xcode. */ }
  for (const tool of ['swift', 'metal']) {
    try { const file = invoke('/usr/bin/xcrun', ['--find', tool]); if (path.isAbsolute(file)) result[tool] = file; } catch { /* Optional tool unavailable. */ }
  }
  return result;
}
function candidates(root) {
  const result = []; let count = 0;
  function visit(dir, depth) {
    if (depth > 12) return;
    const children = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      if (++count > 20000) throw Error('Project discovery limit exceeded');
      if (child.isSymbolicLink() || child.name.startsWith('.') || ['node_modules', 'Pods', 'Carthage', 'build', 'DerivedData'].includes(child.name)) continue;
      const file = path.join(dir, child.name);
      if (child.isDirectory() && /\.(xcworkspace|xcodeproj)$/.test(child.name)) result.push(file);
      else if (child.isFile() && child.name === 'Package.swift') result.push(file);
      else if (child.isDirectory()) visit(file, depth + 1);
    }
  }
  visit(root, 0); return result;
}
async function openInXcode(projectRoot, { dialog, shell, discovery }) {
  const xcode = discovery || discoverXcode();
  if (!xcode.available) return { opened: false, reason: 'unavailable' };
  let root, options;
  try { root = fs.realpathSync(projectRoot); options = candidates(root); } catch { return { opened: false, reason: 'no_project' }; }
  if (!options.length) return { opened: false, reason: 'no_project' };
  let selected = options[0];
  if (options.length > 1) {
    let choice;
    try { choice = await dialog.showOpenDialog({ title: 'Choose an Xcode project or Swift package', defaultPath: root, properties: ['openFile', 'openDirectory'], filters: [{ name: 'Xcode projects and Swift packages', extensions: ['xcworkspace', 'xcodeproj', 'swift'] }] }); }
    catch { return { opened: false, reason: 'canceled' }; }
    if (choice.canceled || choice.filePaths?.length !== 1) return { opened: false, reason: 'canceled' };
    try { selected = fs.realpathSync(choice.filePaths[0]); } catch { return { opened: false, reason: 'no_project' }; }
    if (!options.includes(selected)) return { opened: false, reason: 'no_project' };
  }
  // Recheck each component after the picker; never open a redirected target.
  try {
    if (fs.realpathSync(selected) !== selected || !fs.existsSync(selected)) return { opened: false, reason: 'no_project' };
    // Explicit app selection matters for Package.swift, whose default handler
    // may be another editor. Never execute project text or change xcode-select.
    const app = path.dirname(path.dirname(xcode.developerDir));
    await new Promise((resolve, reject) => childProcess.execFile('/usr/bin/open', ['-a', app, selected], { env: cleanEnvironment(), timeout: 5000 }, error => error ? reject(error) : resolve()));
    return { opened: true };
  } catch { return { opened: false, reason: 'unavailable' }; }
}
module.exports = { discoverXcode, openInXcode };
