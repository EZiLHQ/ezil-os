import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 THE ENTRY CONTRACT FOR `/os`, pinned against the source that has to
 * honour it.
 *
 * `/os` is not a React route. It is the host document for a separate
 * jQuery/webpack application delivered as an inline boot payload plus two
 * `<script src>` tags, and **a `<script>` element React inserts during a
 * client-side navigation is never executed by the browser**
 * (docs/PLATFORM-NOTES.md §17). So any path into `/os` that is a client-side
 * navigation lands the user on a page that will never boot.
 *
 * `redirect()` inside a server action IS a client-side navigation — the
 * App Router performs it, not the browser. That is exactly how
 * `/login?returnUrl=%2Fos` produced a permanently dead page: MEASURED 30s
 * after sign-in, `bundleFetched: 0`, `window.ezil` undefined, no taskbar, no
 * visible text, and a full-screen wallpaper still on screen.
 *
 * These assertions read the source because the property is about which
 * MECHANISM the code uses, and no runtime assertion can see that: a test that
 * called the action would need a real Supabase session, and a test that
 * mocked one would be asserting against the mock. The failure mode this
 * guards is a future contributor "tidying up" the return value back into a
 * `redirect()`, which type-checks, lints, passes every behavioural test, and
 * breaks the login path.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8').replace(/\r\n/g, '\n');

const actions = read('./actions.ts');
const form = read('./login-form.tsx');
const callback = read('../auth/callback/route.ts');
const osPage = read('../os/page.tsx');
const loginPage = read('./page.tsx');

/** The body of one exported function, from its signature to the next one. */
function functionBody(source: string, name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const rest = source.slice(start + 1);
    const next = rest.indexOf('\nexport ');
    return next === -1 ? rest : rest.slice(0, next);
}

/** Strip comments, so documenting the trap does not read as falling into it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
}

describe('the sign-in path lands on a DOCUMENT load', () => {
    it('🔴 signInWithPassword does not call redirect()', () => {
        expect(code(functionBody(actions, 'signInWithPassword'))).not.toMatch(/\bredirect\(/);
    });

    it('it returns the destination instead, for the client to navigate to', () => {
        expect(functionBody(actions, 'signInWithPassword')).toMatch(/return \{ redirectTo: returnUrl \}/);
    });

    it('and the form performs that navigation as a real document load', () => {
        expect(code(form)).toMatch(/window\.location\.assign\(result\.redirectTo\)/);
        // Not the router: `router.push` reproduces the exact defect.
        expect(code(form)).not.toMatch(/useRouter|router\.(push|replace)/);
    });

    it('the destination is narrowed to a same-origin path before it is returned', () => {
        // It reaches `window.location.assign`, so an unfiltered value is an
        // open redirect. See `safeReturnUrl` and its tests.
        expect(functionBody(actions, 'signInWithPassword')).toMatch(/safeReturnUrl\(/);
    });
});

describe('the OAuth path lands on a DOCUMENT load', () => {
    it('/auth/callback stays a route handler, whose 302 the browser follows', () => {
        expect(callback).toMatch(/export async function GET\(/);
        expect(callback).toMatch(/NextResponse\.redirect\(/);
        // A server action here would silently become a client-side navigation.
        expect(code(callback)).not.toMatch(/'use server'/);
        expect(code(callback)).not.toMatch(/from 'next\/navigation'/);
    });

    it('and it narrows returnUrl too', () => {
        expect(callback).toMatch(/safeReturnUrl\(/);
    });
});

describe('/os checks its own arrival, because senders are a convention', () => {
    it('renders the watchdog', () => {
        expect(code(osPage)).toMatch(/<BootWatchdog \/>/);
    });

    it('still emits the boot payload before the bundle, in that order', () => {
        const body = code(osPage);
        const payload = body.indexOf('bootPayloadScript(payload)');
        const icons = body.indexOf('src="/os/icons.js"');
        const bundle = body.indexOf('src="/os/bundle.min.js"');
        expect(payload).toBeGreaterThan(-1);
        expect(payload).toBeLessThan(icons);
        expect(icons).toBeLessThan(bundle);
    });

    it('nothing in the app links to /os with a client-side <Link>', () => {
        // Not a style rule: a <Link href="/os"> is the same defect as the
        // server-action redirect. If one is ever added deliberately, the
        // watchdog turns it into one reload rather than a dead page — but it
        // should be a deliberate act, so this fails first.
        for (const [name, source] of Object.entries({ form, callback, osPage, actions, loginPage })) {
            expect(code(source), name).not.toMatch(/<Link[^>]*href=["'{]*\/os["'}]/);
        }
    });
});

describe('/ redirects into /os, so its one known client-side sender must be a real link', () => {
    // `/` (the root route, `../page.tsx`) now redirects an authenticated
    // visitor straight into `Routes.OS` (see `../page-entry.test.ts`). That
    // is only safe as long as every client-side way of reaching `/` is a
    // real document load, not an App Router soft navigation — same reasoning
    // as the sign-in path above. The logo on this page is the one such
    // sender, so it must stay a plain `<a>`.

    it('🔴 the /login logo is a plain <a href={Routes.HOME}>, not a <Link>', () => {
        expect(code(loginPage)).toMatch(/<a href=\{Routes\.HOME\}/);
    });

    it('and Routes.HOME never appears on a <Link> anywhere in this file', () => {
        // If someone "tidies up" the <a> back into Next's <Link> for
        // consistency with the Terms/Privacy links below it, this fails:
        // that conversion turns the eventual /os redirect back into a soft
        // nav that never executes /os's <script src> tags.
        expect(code(loginPage)).not.toMatch(/<Link[^>]*href=\{Routes\.HOME\}/);
    });
});

/**
 * 🔴 EZiL OS IS INVITE-ONLY, AND THAT IS AN ENTRY CONTRACT TOO.
 *
 * Accounts are created by `bun tools/invite.ts add <email>`, which writes the
 * `ezil_os_access` row and then asks Supabase to send an invite; an invited
 * person sets their password on `/auth/invited`. `signUpWithPassword` and the
 * form's `'sign-up'` mode were deleted for this (row A2).
 *
 * The sweep below reads every source file under `app/src` rather than the
 * three files this row touched, because the failure it guards is somebody
 * adding a NEW surface with a sign-up call on it — which no assertion against
 * a fixed list of files can see. It is a decision, not a lint rule: if
 * self-service sign-up ever becomes the intent, delete this block deliberately.
 */
const APP_SRC = path.resolve(here, '../..');

function* sourceFilesUnder(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* sourceFilesUnder(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            // Test files are excluded: they are not app surfaces, and THIS
            // file has to be able to write the pattern down in order to
            // search for it.
            yield full;
        }
    }
}

describe('there is no way to create an account from the app', () => {
    it('🔴 nothing under app/src calls auth.signUp(', () => {
        const offenders: string[] = [];
        let scanned = 0;
        for (const file of sourceFilesUnder(APP_SRC)) {
            scanned += 1;
            // Comments are stripped, so a file that DOCUMENTS the removal (as
            // `actions.ts` does) does not read as reintroducing it.
            if (/\bauth\s*\.\s*signUp\s*\(/.test(code(readFileSync(file, 'utf8')))) {
                offenders.push(path.relative(APP_SRC, file));
            }
        }
        // The positive control: the sweep really did read the tree. Without
        // this, an empty walk would pass silently and prove nothing.
        expect(scanned).toBeGreaterThan(40);
        expect(offenders).toEqual([]);
    });

    it('the sign-up action is gone from actions.ts', () => {
        // `code()` first: `actions.ts` DOCUMENTS the deletion in a comment,
        // and documenting it must not read as doing it.
        expect(code(actions)).not.toMatch(/signUpWithPassword/);
        expect(code(actions)).not.toMatch(/signUp\b/);
        // Positive control: sign-IN is still there, so this is not passing
        // because the file failed to load.
        expect(actions).toMatch(/export async function signInWithPassword\(/);
        expect(actions).toMatch(/export async function signInWithGoogle\(/);
        expect(actions).toMatch(/export async function signOut\(/);
    });

    it('the form has no sign-up mode, toggle or new-password branch', () => {
        const body = code(form);
        expect(body).not.toMatch(/'sign-up'/);
        expect(body).not.toMatch(/setMode|Create account|Create one/);
        expect(body).not.toMatch(/new-password/);
        expect(body).not.toMatch(/minLength/);
        // Positive control: the sign-in form itself survived the deletion.
        expect(body).toMatch(/signInWithPassword/);
        expect(body).toMatch(/Continue with Google/);
    });
});
