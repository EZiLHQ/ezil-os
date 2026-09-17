'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function check(dir) { for (const item of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) check(file); else if (/\.(cjs|js)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); } }
for (const dir of ['src', 'ui', 'scripts', 'test']) check(path.join(root, dir));
console.log('Native host JavaScript syntax checks passed');
