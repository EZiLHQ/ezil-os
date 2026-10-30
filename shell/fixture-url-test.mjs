import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixtureUrl } from './fixture-url-test-support.mjs';

for (const file of ['ezil/ui/Settings/late-focus-browser-test.mjs', 'responsiveness-browser-test.mjs', 'seam-minimise-browser-test.mjs']) {
    test(`${file}: real route callback rejects lookalikes and matches exact paths`, async () => {
        const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
        const HOST = source.match(/const HOST = '([^']+)'/)[1];
        const DESKTOP_URL = source.match(/const DESKTOP_URL = '([^']+)'/)[1];
        const start = source.indexOf("await page.route('**/*', async (route) => {");
        const end = source.indexOf(file === 'seam-minimise-browser-test.mjs' ? '\n});' : '\n    });', start);
        let handler;
        await vm.runInNewContext(source.slice(start, end + (file === 'seam-minimise-browser-test.mjs' ? 4 : 8)).replace('await page.route', 'page.route'), {
            page: { route: (_pattern, callback) => { handler = callback; } }, fixtureUrl, URL, HOST, DESKTOP_URL,
            VIEWER_HTML: 'viewer', DOC_HTML: 'document', state: {},
        });
        const invoke = async url => {
            let result;
            await handler({ request: () => ({ url: () => url, method: () => 'GET' }),
                abort: () => { result = { aborted: true }; },
                fulfill: answer => { result = answer; },
                continue: () => { throw new Error('offline fixture must not request external URLs'); } });
            return result;
        };
        for (const url of [`${HOST}/os`, `${HOST}/api/shell/desktop?confirm=frame`]) {
            assert.equal((await invoke(url)).status, 200);
        }
        assert.equal((await invoke(DESKTOP_URL)).body, 'viewer');
        for (const url of [
            `${HOST}.evil.invalid/os`, `${HOST}@evil.invalid/os`,
            `https://evil.invalid/?expected=${HOST}/api/shell/desktop&confirm=frame`,
            HOST.replace('https:', 'http:')+'/os', `${HOST}:444/os`,
            HOST.replace('https://','https://user:password@')+'/os',
            'not a URL', 'https://[broken', '/api/shell/desktop?confirm=frame',
            new URL(DESKTOP_URL).origin+'.evil.invalid/',
        ]) assert.deepEqual(await invoke(url), { aborted: true }, url);
        for (const path of ['/not-api?next=/api/shell/desktop&confirm=frame', '/api/shell/desktop-evil?confirm=frame', '/api/shell/%64esktop?confirm=frame']) {
            assert.equal((await invoke(HOST+path)).status, 404, path);
        }
        assert.deepEqual(JSON.parse((await invoke(`${HOST}/api/shell/desktop?next=confirm=frame`)).body), { ok: true, guacamoleRunning: true });
        assert.equal((await invoke(new URL('/wrong-path', DESKTOP_URL).href)).aborted, true);
    });
}
