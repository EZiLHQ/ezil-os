/**
 * EZiL OS is open: anyone who can sign in may use it. The invite gate
 * (`ezil_os_access` + `EZIL_OS_ACCESS_MODE`) was removed when sign-up opened to
 * everyone at os.ezil.org. These pins keep it removed, keep the one remaining
 * refusal ("sign in first") intact, and keep `/login` from ever redirecting.
 *
 * Rendering these Server Components for real needs a Next request scope, a
 * Supabase session and a database, so the page-side properties are pinned
 * against the source, as `./entry-contract.test.ts` does. The procedure-side
 * property is tested behaviourally at the bottom.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// `trpc.ts` imports the database client and `next/headers` through the
// Supabase server client; neither is reachable (or needed) from a unit test.
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({}) }));

import { createCallerFactory, createTRPCRouter, protectedProcedure } from '@/server/api/trpc';

// 🔴 `fileURLToPath`, not `new URL(...).pathname`: on win32 the latter yields
// `/C:/…`, which `path.resolve` then mangles, and this matrix has a Windows
// runner. `\r\n` is normalised for the same reason — a checkout with CRLF
// endings must not fail a source pin that is about code, not line endings.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8').replace(/\r\n/g, '\n');

/** Strip comments, so documenting a trap does not read as falling into it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
}

const osPage = read('../os/page.tsx');
const computersLayout = read('../computers/layout.tsx');
const computerLayout = read('../computer/layout.tsx');
const loginPage = read('./page.tsx');
const loginForm = read('./login-form.tsx');
const rootPage = read('../page.tsx');
const trpcSource = read('../../server/api/trpc.ts');
const confirmRoute = read('../auth/confirm/route.ts');
const invitedPage = read('../auth/invited/page.tsx');
const inviteCli = read('../../../../tools/invite.ts');

/** Every surface a signed-in visitor can land on. */
const PROTECTED = {
    'os/page.tsx': osPage,
    'computers/layout.tsx': computersLayout,
    'computer/layout.tsx': computerLayout,
};

describe('🔴 no surface consults an allow-list', () => {
    it.each(Object.entries({ ...PROTECTED, 'server/api/trpc.ts': trpcSource, 'login/page.tsx': loginPage }))(
        '%s has no access decision and no not-invited refusal',
        (_name, source) => {
            const body = code(source);
            expect(body).not.toMatch(/ctx\.access\(|osAccessFor|osAccessLookup|os-access/);
            expect(body).not.toMatch(/not_invited|NOT_INVITED|EZIL_OS_ACCESS_MODE/);
            expect(body).not.toMatch(/FORBIDDEN/);
        },
    );

    it.each(Object.entries(PROTECTED))('%s still bounces an UNAUTHENTICATED visitor to login with a returnUrl', (_name, source) => {
        expect(code(source)).toMatch(/if \(!ctx\.user\)/);
        expect(code(source)).toMatch(/getReturnUrlQueryParam\(/);
    });
});

describe('/login never redirects, so nothing can loop through it', () => {
    it('/ sends a signed-in visitor to /os and everyone else to /login', () => {
        // Also pinned by `../page-entry.test.ts`.
        expect(code(rootPage)).toMatch(/redirect\(user \? Routes\.OS : Routes\.LOGIN\)/);
    });

    it('/login performs no redirect of its own', () => {
        expect(code(loginPage)).not.toMatch(/\bredirect\(/);
        expect(code(loginPage)).not.toMatch(/from 'next\/navigation'/);
    });

    it('/login does not even look the visitor up, so it cannot bounce them', () => {
        expect(code(loginPage)).not.toMatch(/getUser\(\)/);
        expect(code(loginPage)).not.toMatch(/createClient\(/);
    });
});

describe('the sign-in page says how to get an account', () => {
    it('Google creates the account on first sign-in', () => {
        expect(code(loginPage)).toMatch(/Sign in or get started with Google\./);
        expect(loginForm).toMatch(/Continue with Google/);
    });

    it('the email form says it is for existing accounts, since it cannot create one', () => {
        expect(code(loginForm)).toMatch(/Email and password work for existing accounts\. New accounts start with Continue with Google\./);
    });

    it('there is no invite-only wording and no "not on the list" panel left', () => {
        for (const source of [loginPage, loginForm]) {
            expect(source).not.toMatch(/invite-only|not on the list|ask a maintainer/i);
        }
    });

    it('opening sign-up adds no sign-up call: accounts come from Supabase OAuth', () => {
        // Pinned in full by `./entry-contract.test.ts`.
        expect(code(loginForm)).not.toMatch(/auth\.signUp\(/);
    });
});

describe('the invited-user landing keeps the document-load contract', () => {
    it('/auth/confirm is a route handler, whose 3xx the browser follows', () => {
        expect(confirmRoute).toMatch(/export async function GET\(/);
        expect(confirmRoute).toMatch(/NextResponse\.redirect\(/);
        // A server action here would silently become a client-side navigation
        // and `/os` would never boot — see `./entry-contract.test.ts`.
        expect(code(confirmRoute)).not.toMatch(/'use server'/);
        expect(code(confirmRoute)).not.toMatch(/from 'next\/navigation'/);
    });

    it('and it narrows its destination', () => {
        expect(confirmRoute).toMatch(/safeReturnUrl\(/);
    });

    it('🔴 /auth/invited leaves with window.location.assign, never the router', () => {
        const body = code(invitedPage);
        expect(body).toMatch(/window\.location\.assign\(Routes\.OS\)/);
        expect(body).not.toMatch(/useRouter|router\.(push|replace)/);
        expect(body).not.toMatch(/<Link[^>]*href=["'{]*\/os["'}]/);
    });

    it('it reads the fragment in an effect, not during render', () => {
        // `window` does not exist on the server, and a first paint that
        // differs between server and client is docs/PLATFORM-NOTES.md §14's
        // hydration hazard.
        const body = code(invitedPage);
        const effect = body.indexOf('useEffect(');
        const hashRead = body.indexOf('window.location.hash');
        expect(effect).toBeGreaterThan(-1);
        expect(hashRead).toBeGreaterThan(effect);
    });

    it('and it strips the tokens out of the address bar once they are spent', () => {
        expect(code(invitedPage)).toMatch(/history\.replaceState\(/);
    });
});

describe('the invite CLI points at a page that exists', () => {
    it('🔴 tools/invite.ts redirects to /auth/invited, not /auth/callback', () => {
        // `/auth/callback` reads `?code=` and an invite is not a PKCE flow, so
        // the old target could never see the session. This assertion is what
        // stops the two halves drifting apart again.
        expect(inviteCli).toMatch(/const redirectTo = `\$\{origin\}\/auth\/invited`/);
    });

    it('and that path is the one /auth/confirm sends an invite to', () => {
        expect(read('../auth/confirm/confirm-link.ts')).toMatch(
            /INVITED_PATH = '\/auth\/invited'/,
        );
    });
});

describe('protectedProcedure requires a signed-in user, and only that', () => {
    const router = createTRPCRouter({
        whoami: protectedProcedure.query(({ ctx }) => ctx.user.id),
    });
    const caller = (user: { id: string } | null) =>
        createCallerFactory(router)({
            db: undefined as never,
            user: user as never,
            headers: new Headers(),
        });

    it('refuses an anonymous caller with UNAUTHORIZED', async () => {
        await expect(caller(null).whoami()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('🔴 lets ANY signed-in user through — there is no allow-list to consult', async () => {
        // A brand-new Google account with no row anywhere.
        await expect(caller({ id: 'a-brand-new-user' }).whoami()).resolves.toBe('a-brand-new-user');
    });
});
