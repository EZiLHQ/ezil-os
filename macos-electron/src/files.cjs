'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
function identity(file) { const s = fs.lstatSync(file); if (s.isSymbolicLink()) throw Error('Symbolic link refused'); return `${s.dev}:${s.ino}`; }
function noLinks(file) {
  const full = path.resolve(file); let p = path.parse(full).root;
  for (const part of full.slice(p.length).split(path.sep).filter(Boolean)) { p = path.join(p, part); if (fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false })) identity(p); }
  return full;
}
function privateDir(dir) { noLinks(dir); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); return dir; }
function atomic(file, value) {
  noLinks(path.dirname(file));
  if (fs.lstatSync(file, { throwIfNoEntry: false })) identity(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function readJSON(file) { noLinks(file); return JSON.parse(fs.readFileSync(file, 'utf8')); }
function treeInventory(root, limit = 100000) {
  noLinks(root); const result = []; let bytes = 0;
  function visit(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw Error('Link or special file refused');
    bytes += stat.isFile() ? stat.size : 0;
    if (result.length >= limit || bytes > 20 * 1024 ** 3) throw Error('Workspace exceeds import/removal limits');
    result.push({ file, identity: `${stat.dev}:${stat.ino}`, directory: stat.isDirectory() });
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
  }
  visit(root); return result;
}
// No recursive rm: every entry is inventoried, then identity checked immediately
// before unlink/rmdir. This is an accidental-escape guard, not containment of
// malicious concurrent processes running as the same Mac user.
function removeInventory(entries) {
  for (const entry of entries) if (identity(noLinks(entry.file)) !== entry.identity) throw Error('File identity changed');
  for (const entry of [...entries].reverse()) {
    if (identity(noLinks(entry.file)) !== entry.identity) throw Error('File identity changed');
    if (entry.directory) fs.rmdirSync(entry.file); else fs.unlinkSync(entry.file);
  }
}
function copyTree(source, target) {
  const entries = treeInventory(source);
  if (fs.existsSync(target)) throw Error('Import destination exists');
  for (const entry of entries) {
    if (identity(noLinks(entry.file)) !== entry.identity) throw Error('Import changed');
    const dest = path.join(target, path.relative(source, entry.file));
    noLinks(dest);
    if (entry.directory) privateDir(dest);
    else {
      const fd = fs.openSync(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (`${stat.dev}:${stat.ino}` !== entry.identity) throw Error('Import changed');
        const out = fs.openSync(dest, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, stat.mode & 0o700);
        try {
          const buffer = Buffer.alloc(1024 * 1024); let copied = 0, n;
          while ((n = fs.readSync(fd, buffer)) > 0) {
            copied += n; if (copied > stat.size) throw Error('Import changed during copy');
            let offset = 0; while (offset < n) offset += fs.writeSync(out, buffer, offset, n - offset);
          }
          const after = fs.fstatSync(fd);
          if (copied !== stat.size || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size) throw Error('Import changed during copy');
        } finally { fs.closeSync(out); }
      } finally { fs.closeSync(fd); }
    }
  }
}
module.exports = { identity, noLinks, privateDir, atomic, readJSON, treeInventory, removeInventory, copyTree };
