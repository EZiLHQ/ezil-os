import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMcpObservation, OBSERVE_PATH } from './mcp-observation.mjs';
import { createSidecarServer } from './server.mjs';

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
}

const CHROME = process.env.EZIL_TEST_CHROMIUM;
test('real CDP observes one owned fixture page without exposing form values or acting on it', { skip: !CHROME }, async () => {
    const { BrowserSurface } = await import('./browser.mjs');
    const profile = await mkdtemp(join(tmpdir(), 'ezil-browser-observe-'));
    const chrome = spawn(CHROME, [
        '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking',
        '--disable-component-update', '--disable-sync', '--no-first-run',
        '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
        '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore' });
    let writes = 0;
    const target = createServer((request, response) => {
        if (request.method === 'POST') writes += 1;
        response.setHeader('content-type', 'text/html');
        response.end('<main><h1>Profile Builder fixture</h1><form method="POST"><input aria-label="Profile name" name="name"><input type="password" name="password" value="secret-fixture-only"><button>Save sample</button></form></main>');
    });
    let sidecar;
    try {
        let port;
        for (let attempt = 0; attempt < 60 && !port; ++attempt) {
            try { port = parseInt(await readFile(join(profile, 'DevToolsActivePort'), 'utf8'), 10); }
            catch { await delay(100); }
        }
        assert.ok(port, 'disposable local Chrome announced a debugging port');
        const surface = new BrowserSurface('http://127.0.0.1:' + port);
        const browser = await surface.connect();
        const [page] = browser.contexts()[0].pages();
        const origin = await listen(target);
        await page.goto(origin + '/builder/profile-builder');
        const observe = createMcpObservation(surface, { origin });
        sidecar = createSidecarServer(surface, { observe });
        const url = await listen(sidecar) + OBSERVE_PATH;
        const binding = 'a'.repeat(64);
        const send = async body => (await fetch(url, {
            method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
        })).json();
        const first = await send({ binding });
        assert.deepEqual(Object.keys(first).sort(), [
            'browserSessionId', 'expiresAt', 'observed', 'ok', 'profileHeadingVisible', 'universeIdentity',
        ]);
        assert.equal(first.observed, 'profile_builder');
        assert.equal(first.profileHeadingVisible, true);
        assert.equal(first.universeIdentity, 'unverified');
        assert.doesNotMatch(JSON.stringify(first), /secret-fixture-only|127\.0\.0\.1|Profile Builder fixture/);
        const resume = { binding, browserSessionId: first.browserSessionId };
        assert.deepEqual(await send(resume), first);
        assert.deepEqual(await send({ ...resume, binding: 'b'.repeat(64) }), { ok: false, error: 'browser_session_stale' });
        assert.deepEqual(await send({ ...resume, selector: 'input' }), { ok: false, error: 'browser_invalid_request' });
        assert.equal(writes, 0, 'observation does not submit');
        // Fixture creation uses the local browser directly, never the observation API.
        await page.getByLabel('Profile name').fill('Local synthetic builder');
        await page.getByRole('button', { name: 'Save sample' }).click();
        await page.waitForLoadState('domcontentloaded');
        assert.equal(writes, 1);
        assert.deepEqual(await send(resume), { ok: false, error: 'browser_session_stale' });
        await page.goto(origin + '/auth/ezil-id/login?secret=synthetic-boundary-value');
        const handoff = await send({ binding });
        assert.equal(handoff.observed, 'interactive_sign_in_required');
        assert.equal(handoff.profileHeadingVisible, false);
        assert.doesNotMatch(JSON.stringify(handoff), /synthetic-boundary-value|secret-fixture-only/);
        await page.goto(origin + '/?role=builder&redirect=http%3A%2F%2Fexample.invalid%2Fignored');
        const builderHandoff = await send({ binding });
        assert.equal(builderHandoff.observed, 'interactive_sign_in_required');
        assert.doesNotMatch(JSON.stringify(builderHandoff), /example.invalid|redirect/);
        await page.goto(origin + '/?role=builder&role=client');
        assert.deepEqual(await send({ binding }), { ok: false, error: 'browser_page_unavailable' });
        await page.goto('about:blank');
        assert.deepEqual(await send({ binding }), { ok: false, error: 'browser_page_unavailable' });
        assert.equal(writes, 1);
    } finally {
        sidecar?.close();
        target.close();
        if (chrome.exitCode === null) {
            const exited = once(chrome, 'exit');
            chrome.kill('SIGTERM');
            await exited;
        }
        await rm(profile, { recursive: true, force: true });
    }
});
