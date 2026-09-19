'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { discoverXcode, openInXcode } = require('../src/xcode.cjs');
function run(file, args) {
  if (file.endsWith('xcode-select')) return '/Applications/Xcode.app/Contents/Developer\n';
  if (file.endsWith('xcodebuild')) return 'Xcode 27.0\nBuild version test\n';
  return `/toolchain/${args[1]}\n`;
}
test('discovery distinguishes full Xcode, missing Metal and Command Line Tools', () => {
  assert.equal(discoverXcode({ platform: 'linux' }).available, false);
  const full = discoverXcode({ platform: 'darwin', run }); assert.equal(full.available, true); assert.equal(full.swift, '/toolchain/swift');
  const partial = discoverXcode({ platform: 'darwin', run: (file, args) => { if (args.includes('metal')) throw Error(); return run(file, args); } });
  assert.equal(partial.available, true); assert.equal(partial.metal, null);
  const clt = discoverXcode({ platform: 'darwin', run: () => { throw Error('CLT only'); } }); assert.equal(clt.available, false);
});
const discovery = { available: true, version: 'Xcode 27.0', developerDir: '/Applications/Xcode.app/Contents/Developer', swift: '/toolchain/swift', metal: null };
function projectRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-xcode-resolution-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('resolution opens a nested workspace without scanning its internal project and ignores dependency trees', async t => {
  const root = projectRoot(t), workspace = path.join(root, 'Sources/Example.xcworkspace'); fs.mkdirSync(path.join(workspace, 'Internal.xcodeproj'), { recursive: true });
  for (const ignored of ['node_modules', '.git', '.build', 'Pods', 'Carthage', 'build', 'DerivedData']) fs.mkdirSync(path.join(root, ignored, 'Ignored.xcodeproj'), { recursive: true });
  const calls = []; t.mock.method(cp, 'execFile', (file, args, options, done) => { calls.push({ file, args }); done(null); });
  const result = await openInXcode(root, { discovery, dialog: { showOpenDialog: () => assert.fail('Single real candidate needs no picker') } });
  assert.deepEqual(result, { opened: true }); assert.deepEqual(calls, [{ file: '/usr/bin/open', args: ['-a', '/Applications/Xcode.app', workspace] }]);
});
test('same-named projects require an explicit picker choice; canceled, missing and redirected choices do not launch', async t => {
  const root = projectRoot(t), first = path.join(root, 'A/App.xcodeproj'), second = path.join(root, 'B/App.xcodeproj');
  fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second, { recursive: true });
  const calls = []; t.mock.method(cp, 'execFile', (_file, args, _options, done) => { calls.push(args); done(null); });
  const dialog = { showOpenDialog: async options => { assert.equal(options.defaultPath, root); return { canceled: false, filePaths: [second] }; } };
  assert.deepEqual(await openInXcode(root, { discovery, dialog }), { opened: true }); assert.equal(calls[0][2], second); calls.length = 0;
  for (const answer of [{ canceled: true }, { canceled: false, filePaths: [] }, { canceled: false, filePaths: [first, second] }]) {
    dialog.showOpenDialog = async () => answer; assert.deepEqual(await openInXcode(root, { discovery, dialog }), { opened: false, reason: 'canceled' });
  }
  dialog.showOpenDialog = async () => { throw Error('Picker unavailable'); };
  assert.deepEqual(await openInXcode(root, { discovery, dialog }), { opened: false, reason: 'canceled' });
  const outside = projectRoot(t); fs.mkdirSync(path.join(outside, 'Outside.xcodeproj'));
  dialog.showOpenDialog = async () => {
    fs.rmdirSync(first); fs.symlinkSync(path.join(outside, 'Outside.xcodeproj'), first);
    return { canceled: false, filePaths: [first] };
  };
  assert.deepEqual(await openInXcode(root, { discovery, dialog }), { opened: false, reason: 'no_project' }); assert.equal(calls.length, 0);
});
test('unavailable Xcode, missing roots and OS launch failures return fixed results', async t => {
  const root = projectRoot(t); fs.writeFileSync(path.join(root, 'Package.swift'), '// synthetic package');
  let calls = 0; t.mock.method(cp, 'execFile', (_file, _args, _options, done) => { calls++; done(Error('Synthetic failure')); });
  assert.deepEqual(await openInXcode(root, { discovery: { ...discovery, available: false } }), { opened: false, reason: 'unavailable' });
  assert.deepEqual(await openInXcode(path.join(root, 'missing'), { discovery }), { opened: false, reason: 'no_project' }); assert.equal(calls, 0);
  assert.deepEqual(await openInXcode(root, { discovery }), { opened: false, reason: 'unavailable' }); assert.equal(calls, 1);
});
test('checked-in SwiftUI fixture resolves to its project and shared XCTest scheme references real targets', { skip: process.platform !== 'darwin' }, async t => {
  // Read-only structural validation; never invoke xcodebuild or modify fixtures.
  const root = path.resolve(__dirname, 'fixtures/mac-project'), project = path.join(root, 'EZiLFixture.xcodeproj');
  const parsed = JSON.parse(cp.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(project, 'project.pbxproj')], { encoding: 'utf8' }));
  const objects = parsed.objects, scheme = fs.readFileSync(path.join(project, 'xcshareddata/xcschemes/EZiLFixture.xcscheme'), 'utf8');
  const targets = Object.values(objects).filter(object => object.isa === 'PBXNativeTarget');
  assert.equal(targets.length, 2);
  const app = targets.find(target => target.productType === 'com.apple.product-type.application');
  const tests = targets.find(target => target.productType === 'com.apple.product-type.bundle.unit-test');
  assert.ok(app && tests); assert.equal(objects[tests.dependencies[0]].target, Object.keys(objects).find(id => objects[id] === app));
  for (const match of scheme.matchAll(/<BuildableReference\b([^>]+)\/>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/(\w+)="([^"]*)"/g)].map(value => [value[1], value[2]]));
    const target = objects[attrs.BlueprintIdentifier]; assert.equal(target.name, attrs.BlueprintName);
    assert.equal(objects[target.productReference].path, attrs.BuildableName);
  }
  assert.match(scheme, /<TestAction buildConfiguration="Debug"/); assert.match(scheme, /<TestableReference skipped="NO">/);
  const projectConfig = objects[parsed.rootObject].buildConfigurationList;
  for (const id of objects[projectConfig].buildConfigurations) {
    assert.equal(objects[id].buildSettings.CODE_SIGNING_ALLOWED, 'NO'); assert.equal(objects[id].buildSettings.CODE_SIGNING_REQUIRED, 'NO');
  }
  for (const target of targets) {
    const sourcePhase = target.buildPhases.map(id => objects[id]).find(phase => phase.isa === 'PBXSourcesBuildPhase');
    assert.ok(sourcePhase.files.length);
    for (const id of sourcePhase.files) {
      const reference = objects[objects[id].fileRef]; assert.ok(fs.existsSync(path.join(root, target.name, reference.path)));
    }
  }
  const testSource = fs.readFileSync(path.join(root, 'EZiLFixtureTests/EZiLFixtureTests.swift'), 'utf8');
  assert.match(testSource, /import XCTest/); assert.match(testSource, /@testable import EZiLFixture/); assert.equal([...testSource.matchAll(/func test\w+\(/g)].length, 2);
  const calls = []; t.mock.method(cp, 'execFile', (_file, args, _options, done) => { calls.push(args); done(null); });
  assert.deepEqual(await openInXcode(root, { discovery, dialog: { showOpenDialog: () => assert.fail('One fixture project') } }), { opened: true });
  assert.equal(calls[0][2], project);
});
test('opening uses selected Xcode, picks multiple candidates, and refuses outside selections and symlinks', { skip: process.platform !== 'darwin' }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-xcode-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  t.mock.method(cp, 'execFileSync', run);
  const launches = []; t.mock.method(cp, 'execFile', (file, args, options, callback) => { launches.push({ file, args }); callback(null); });
  const dialog = { showOpenDialog: async () => ({ canceled: true }) }, shell = {};
  assert.deepEqual(await openInXcode(root, { dialog, shell }), { opened: false, reason: 'no_project' });
  fs.writeFileSync(path.join(root, 'Package.swift'), '// package');
  assert.deepEqual(await openInXcode(root, { dialog, shell }), { opened: true });
  assert.deepEqual(launches[0], { file: '/usr/bin/open', args: ['-a', '/Applications/Xcode.app', path.join(root, 'Package.swift')] });
  fs.mkdirSync(path.join(root, 'App.xcodeproj'));
  assert.deepEqual(await openInXcode(root, { dialog, shell }), { opened: false, reason: 'canceled' });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: ['/Applications/Xcode.app'] });
  assert.deepEqual(await openInXcode(root, { dialog, shell }), { opened: false, reason: 'no_project' });
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path.join(root, 'App.xcodeproj')] });
  assert.deepEqual(await openInXcode(root, { dialog, shell }), { opened: true });
  fs.rmSync(path.join(root, 'App.xcodeproj'), { recursive: true }); fs.unlinkSync(path.join(root, 'Package.swift'));
  fs.symlinkSync('/Applications', path.join(root, 'Linked.xcodeproj'));
  assert.deepEqual(await openInXcode(root, { dialog, shell }), { opened: false, reason: 'no_project' });
});
