// The system-layer codec fingerprints VS Code's .vscdb state by content, so a rewrite
// of the same rows does not re-upload the whole layer. Run the embedded Python against
// real SQLite databases: churn must match, every persistent setting or row change must not.
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SYSTEM_SNAPSHOT_SCRIPT } from './system-snapshot-script';

const python = spawnSync('python3', ['-c', 'import sqlite3'], { encoding: 'utf8' }).status === 0;
const fingerprint = SYSTEM_SNAPSHOT_SCRIPT.slice(SYSTEM_SNAPSHOT_SCRIPT.indexOf('def sqlite_fingerprint'), SYSTEM_SNAPSHOT_SCRIPT.indexOf('def capture'));
const HARNESS = String.raw`
import os, sqlite3, hashlib, tempfile, json
work = tempfile.mkdtemp()
exec(open(os.environ['FP']).read())
p = os.path.join(work, 'state.vscdb')
def db(setup):
    if os.path.exists(p): os.unlink(p)
    con = sqlite3.connect(p); setup(con); con.commit(); con.close()
    return open(p, 'rb').read()
def base(con):
    con.execute('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)')
    con.execute("INSERT INTO ItemTable VALUES ('__$__isNewStorageMarker','true')")
a = db(base)
con = sqlite3.connect(p); con.execute('DELETE FROM ItemTable'); con.execute("INSERT INTO ItemTable VALUES ('__$__isNewStorageMarker','true')"); con.commit(); con.execute('VACUUM'); con.close()
churn = open(p, 'rb').read()
out = {'bytesDiffer': a != churn, 'base': sqlite_fingerprint(a), 'churn': sqlite_fingerprint(churn)}
for m in (0, 1, 2): out['vacuum%d' % m] = sqlite_fingerprint(db(lambda con, m=m: (con.execute('PRAGMA auto_vacuum=%d' % m), base(con))))
out['wal'] = sqlite_fingerprint(db(lambda con: (con.execute('PRAGMA journal_mode=WAL'), base(con))))
out['row'] = sqlite_fingerprint(db(lambda con: (base(con), con.execute("INSERT INTO ItemTable VALUES ('k','v')"))))
out['userVersion'] = sqlite_fingerprint(db(lambda con: (base(con), con.execute('PRAGMA user_version=7'))))
out['notSqlite'] = sqlite_fingerprint(b'not sqlite')
print(json.dumps(out))
`;

describe.skipIf(!python)('system-layer SQLite fingerprint', () => {
  test('same rows rewritten match; persistent settings and rows do not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ezil-fp-'));
    try {
      writeFileSync(join(dir, 'fp.py'), fingerprint);
      const run = spawnSync('python3', ['-c', HARNESS], { encoding: 'utf8', env: { ...process.env, FP: join(dir, 'fp.py') } });
      expect(run.status).toBe(0);
      const r = JSON.parse(run.stdout);
      expect(r.bytesDiffer).toBe(true);
      expect(r.churn).toBe(r.base);
      expect(new Set([r.vacuum0, r.vacuum1, r.vacuum2]).size).toBe(3);
      for (const changed of [r.wal, r.row, r.userVersion]) expect(changed).not.toBe(r.base);
      expect(r.notSqlite).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
