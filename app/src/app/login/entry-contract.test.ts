import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
const callback = read('../auth/callback/route.ts');
const auth0Login = read('../auth/auth0/login/route.ts');
const auth0Callback = read('../auth/auth0/callback/route.ts');
const osPage = read('../os/page.tsx');
const loginPage = read('./page.tsx');
const pricingPage = read('../(marketing)/pricing/page.tsx');
const marketingLayout = read('../(marketing)/layout.tsx');
const marketingHome = read('../(marketing)/_components/home-page.tsx');
const rootPage = read('../page.tsx');

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

    it('and the one sign-in action is a plain link into a route handler, never a soft navigation', () => {
        // "Continue with EZiL ID" is an <a>; the browser follows the route
        // handlers' 302s as document loads. Not a <Link>, not a server action.
        expect(code(loginPage)).toMatch(/<a className="ezil-lock-google" href=\{`\/auth\/auth0\/login\?/);
        expect(code(loginPage)).not.toMatch(/<Link[^>]*auth0/);
        expect(code(loginPage)).not.toMatch(/useRouter|router\.(push|replace)|'use client'/);
        for (const route of [auth0Login, auth0Callback]) {
            expect(route).toMatch(/export async function GET\(/);
            expect(route).toMatch(/NextResponse\.redirect\(/);
            expect(code(route)).not.toMatch(/'use server'/);
            expect(code(route)).not.toMatch(/from 'next\/navigation'/);
        }
        expect(auth0Callback).toMatch(/safeReturnUrl\(/);
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
        const clientOsLink = /<Link[^>]*href=["'{]*\/os["'}]/;
        expect(clientOsLink.test('<Link href="/os">Open</Link>')).toBe(true);
        for (const [name, source] of Object.entries({ callback, auth0Login, auth0Callback, osPage, actions, loginPage, pricingPage, marketingLayout, marketingHome, rootPage })) {
            expect(code(source), name).not.toMatch(clientOsLink);
        }
    });

    it('marketing entry links remain document loads even when destinations come from copy', () => {
        const clientLink = /<Link\b/;
        expect(clientLink.test('<Link href="/login?next=/os">Upgrade</Link>')).toBe(true);
        expect(code(marketingHome)).toMatch(/<a\b/);
        for (const source of [pricingPage, marketingLayout, marketingHome, rootPage]) {
            expect(code(source)).not.toMatch(clientLink);
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
 * 🔴 NO PASSWORD SELF-SIGNUP: auth.signUp remains forbidden.
 *
 * Founder decision (2026-10-20): server-only admin createUser is allowed for
 * an Auth0 identity after its ID token and verified email pass validation.
 * Supabase OAuth and the invite tool also create accounts; this exception
 * does not permit a client or password auth.signUp call.
 *
 * Invited accounts use `bun tools/invite.ts add <email>`, which writes the
 * `ezil_os_access` row and then asks Supabase to send an invite; an invited
 * person sets their password on `/auth/invited`. `signUpWithPassword` and the
 * form's `'sign-up'` mode were deleted for this (row A2).
 *
 * The sweep below reads every source file under `app/src` rather than the
 * three files this row touched, because the failure it guards is somebody
 * adding a NEW surface with a sign-up call on it — which no assertion against
 * a fixed list of files can see. It is a decision, not a lint rule: if
 * password self-service sign-up ever becomes the intent, revisit this block deliberately.
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

describe('there is no password self-signup in the app', () => {
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
    });

    it('the login page has no sign-up mode, toggle or new-password branch', () => {
        const body = code(loginPage);
        expect(body).not.toMatch(/'sign-up'/);
        expect(body).not.toMatch(/setMode|Create account|Create one/);
        expect(body).not.toMatch(/new-password/);
        expect(body).not.toMatch(/minLength/);
        // Positive control: the page itself was read, and still signs in.
        expect(body).toMatch(/Continue with EZiL ID/);
    });
});

/**
 * 🔴 EZiL ID IS THE ONLY SIGN-IN THE UI OFFERS.
 *
 * Production signs in through EZiL ID (Auth0 at id.ezil.work,
 * `/auth/auth0/*`) only. Supabase-hosted Google OAuth, email and password,
 * magic links and password reset are not offered on any page. The server
 * handlers they used (`./actions.ts`, `/auth/callback`, `/auth/confirm`) stay
 * for now; this sweep is about what a person can click.
 *
 * Like the sign-up sweep above, it reads every component under `app/src`
 * rather than a fixed list, because the failure it guards is a NEW surface
 * bringing a second way in back.
 */
const OTHER_SIGN_IN = [
    /Continue with Google|Sign in with Google|get started with Google/i,
    /type=(?:"password"|'password'|\{['"]password['"]\})/,
    /\bsignInWith(?:Google|Password|OAuth|Otp|IdToken)\b/,
    /\bresetPasswordForEmail\b|updateUser\(\s*\{\s*password/,
    /\/login\?method=email/,
];

describe('there is no sign-in UI other than EZiL ID', () => {
    it('the patterns recognise what they are looking for', () => {
        // Positive control for each pattern, so a typo cannot pass silently.
        const samples = ['<span>Continue with Google</span>', '<input type="password" />',
            "import { signInWithGoogle } from './actions';", 'await supabase.auth.updateUser({ password });',
            "href: '/login?method=email'"];
        samples.forEach((sample, index) => expect(sample).toMatch(OTHER_SIGN_IN[index]));
    });

    it('🔴 no component under app/src renders another sign-in option', () => {
        const offenders: string[] = [];
        const scanned: string[] = [];
        for (const file of sourceFilesUnder(APP_SRC)) {
            // Components, plus the marketing copy that feeds their links.
            if (!file.endsWith('.tsx') && !/pricing-content\.ts$/.test(file)) continue;
            const name = path.relative(APP_SRC, file).split(path.sep).join('/');
            scanned.push(name);
            const source = code(readFileSync(file, 'utf8'));
            for (const pattern of OTHER_SIGN_IN) {
                if (pattern.test(source)) offenders.push(`${name}: ${pattern}`);
            }
        }
        // Positive control: the walk reached the surfaces that used to offer them.
        expect(scanned.length).toBeGreaterThan(20);
        expect(scanned).toEqual(expect.arrayContaining(['app/login/page.tsx', 'app/auth/invited/page.tsx', 'app/(marketing)/pricing/pricing-content.ts']));
        expect(offenders).toEqual([]);
    });

    it('the deleted Google and email/password form stays deleted', () => {
        expect(existsSync(path.resolve(here, './login-form.tsx'))).toBe(false);
        // Positive control: the page beside it is really there.
        expect(existsSync(path.resolve(here, './page.tsx'))).toBe(true);
    });
});
