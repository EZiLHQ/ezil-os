/**
 * await-deployed-bundle.mjs — wait until the LIVE app is serving the shell
 * bundle from THIS tree, and fail if it never does.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 * ═══════════════════════════════════════════════════════════════════════════
 * The production suites point at a fixed URL. Between `vercel deploy --prod`
 * returning and the production alias actually pointing at the new deployment
 * there is a window — usually short, occasionally not — in which that URL still
 * serves the PREVIOUS build. A suite that runs inside that window tests the old
 * code and reports success, which is the exact failure this pipeline was
 * written to prevent: a deploy that reported success without taking effect.
 *
 * A fixed `sleep` cannot close that window. It is either too short (and the
 * suites silently verify the wrong build) or too long (and every deploy pays
 * for the worst case). So this waits on the CONDITION instead: the served
 * `/os/bundle.min.js` must be byte-for-byte the committed one.
 *
 * The byte-for-byte idea is not new here — `release-and-wait.mjs` already does
 * it for the container's client script. This is the same discriminator applied
 * to the half of the deploy that Vercel serves.
 *
 * Exit codes follow this directory's convention:
 *   0 = the live app is serving this build
 *   1 = it never started serving it within the budget (a REAL failure)
 *   2 = could not run
 */
import fs from 'node:fs';
import crypto from 'node:crypto';

const APP = process.env.EZIL_E2E_APP ?? 'https://ezil-os.vercel.app';
const BUDGET_MS = Number(process.env.EZIL_DEPLOY_WAIT_MS ?? 180_000);
const GAP_MS = 5_000;
const LOCAL = 'app/public/os/bundle.min.js';

if (!fs.existsSync(LOCAL)) {
    console.error(`SKIP: ${LOCAL} is missing — run shell/build-shell.sh first.`);
    process.exit(2);
}

const src = fs.readFileSync(LOCAL);
const want = {
    bytes: src.byteLength,
    digest: crypto.createHash('sha256').update(src).digest('hex'),
};
console.log(`waiting for ${APP} to serve bundle.min.js — ${want.bytes} bytes, sha256 ${want.digest.slice(0, 12)}…`);

const started = Date.now();
let attempts = 0;
let last = 'no request made';

while (Date.now() - started < BUDGET_MS) {
    attempts++;
    try {
        // Cache-bust: a CDN edge that already has the old object would answer
        // from cache and we would wait out the whole budget against a stale copy.
        const res = await fetch(`${APP}/os/bundle.min.js?deploy-check=${Date.now()}`, {
            headers: { 'cache-control': 'no-cache' },
            redirect: 'follow',
        });
        if (!res.ok) {
            last = `HTTP ${res.status}`;
        } else {
            const body = Buffer.from(await res.arrayBuffer());
            const got = {
                bytes: body.byteLength,
                digest: crypto.createHash('sha256').update(body).digest('hex'),
            };
            if (got.digest === want.digest) {
                console.log(
                    `PASS  the live app is serving THIS build `
                    + `(${got.bytes} bytes, sha256 ${got.digest.slice(0, 12)}…) `
                    + `after ${attempts} check(s), ${Date.now() - started}ms`,
                );
                process.exit(0);
            }
            last = `serving a DIFFERENT build: ${got.bytes} bytes, sha256 ${got.digest.slice(0, 12)}…`;
        }
    } catch (err) {
        last = `request failed: ${err?.message ?? err}`;
    }
    if (Date.now() - started + GAP_MS >= BUDGET_MS) break;
    await new Promise((r) => setTimeout(r, GAP_MS));
}

console.error(
    `FAIL  ${APP} never served this build within ${BUDGET_MS}ms `
    + `(${attempts} checks). Last: ${last}.`,
);
console.error(
    'The deploy reported success but the production alias is not serving it. '
    + 'Do NOT trust a green production suite from this run — it would have '
    + 'tested the previous build.',
);
process.exit(1);
