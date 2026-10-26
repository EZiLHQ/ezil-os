import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const source = readFileSync(new URL('./app-link.js', import.meta.url), 'utf8');
const { parseAppLink } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const apps = [{ id: 'code' }, { id: 'desktop' }];
const repo = 'https://github.ezil.work/team/fixture.git';
assert.deepEqual(parseAppLink('?app=code&repo=' + encodeURIComponent(repo), apps), { id: 'code', repo });
assert.deepEqual(parseAppLink('?app=code&repo=', apps), { id: 'code', repo: '' }); // backend rejects, never root fallback
assert.equal(parseAppLink('?app=code&repo=a&repo=b', apps), null);
assert.deepEqual(parseAppLink('?app=browser&repo=' + encodeURIComponent(repo), apps), { id: 'desktop' });
console.log('repo-link checks passed');
