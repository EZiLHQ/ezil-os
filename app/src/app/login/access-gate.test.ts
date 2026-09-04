/**
 * 🔴 THE PAGE GATES, AND THE LOOP THEY MUST NOT MAKE.
 *
 * `protectedProcedure` is the one authorization implementation, and
 * `server/api/trpc-access.test.ts` proves it behaviourally — including that a
 * refused principal never reaches `computer.getOrCreateDefault`. What no
 * runtime assertion in this repo can see is the ORDER of statements inside a
 * React Server Component: rendering `/os` for real needs a Next request scope,
 * a Supabase session and a database. So the page-side property — "the refusal
 * happens BEFORE anything that writes" — is pinned against the source, the
 * same way `./entry-contract.test.ts` pins which navigation mechanism the
 * login path uses and for the same reason.
 *
 * This file lives under `login/` rather than beside each page because row A2
 * owns `app/src/app/login/**` and the individual page files, but not the
 * directories around them.
 *
 * ── The loop ───────────────────────────────────────────────────────────────
 *     `/`  redirects a signed-in visitor to `/os`
 *     `/os` refuses a visitor who is not on the allow-list -> `/login?error=…`
 *     `/login` … must RENDER. If it redirected a signed-in visitor anywhere,
 *     those two would chase each other and the browser would answer
 *     ERR_TOO_MANY_REDIRECTS instead of an explanation. That is what the last
 *     describe block below is for.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { OS_ACCESS_NOT_INVITED } from '@/server/api/os-access';

const here = path.dirname(new URL(import.meta.url).pathname);
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
const rootPage = read('../page.tsx');
const confirmRoute = read('../auth/confirm/route.ts');
const invitedPage = read('../auth/invited/page.tsx');
const inviteCli = read('../../../../tools/invite.ts');

/** Every surface a signed-in visitor can land on that must consult the gate. */
const GATED = {
    'os/page.tsx': osPage,
    'computers/layout.tsx': computersLayout,
    'computer/layout.tsx': computerLayout,
};

describe('every gated surface asks the one implementation', () => {
    it.each(Object.entries(GATED))('%s calls ctx.access()', (_name, source) => {
        const body = code(source);
        // Not `osAccessFor(` and not a local re-derivation: the decision comes
        // off the context `createTRPCContext` built, which is the same object
        // `protectedProcedure` will read. A second call site of `osAccessFor`
        // in a page is how a second authorization implementation is born.
        expect(body).toMatch(/await ctx\.access\(\)/);
        expect(body).not.toMatch(/osAccessFor\(/);
        expect(body).not.toMatch(/osAccessLookup\(/);
    });

    it.each(Object.entries(GATED))('%s refuses with ?error=not_invited', (_name, source) => {
        expect(code(source)).toMatch(
            new RegExp(`redirect\\(\`\\$\\{Routes\\.LOGIN\\}\\?error=\\$\\{OS_ACCESS_NOT_INVITED\\}\``),
        );
    });

    it('🔴 and NOT with ?returnUrl — that is the loop', () => {
        // `?returnUrl=/os` would send the refused user back to `/os` the
        // moment they signed in again, which is where they were refused.
        for (const [name, source] of Object.entries(GATED)) {
            const refusal = code(source).slice(code(source).indexOf('ctx.access()'));
            expect(refusal, name).not.toMatch(/getReturnUrlQueryParam/);
        }
    });

    it.each(Object.entries(GATED))('%s still bounces an UNAUTHENTICATED visitor to login with a returnUrl', (_name, source) => {
        // The positive control for the assertion above: the two refusals are
        // different, and the older one is untouched.
        expect(code(source)).toMatch(/getReturnUrlQueryParam\(/);
    });
});

describe('🔴 /os refuses BEFORE anything that writes', () => {
    const body = code(osPage);
    const gate = body.indexOf('await ctx.access()');
    const caller = body.indexOf('appRouter.createCaller(ctx)');
    const write = body.indexOf('getOrCreateDefault()');

    it('the three call sites are all present', () => {
        // Otherwise the ordering assertions below would pass on -1 === -1.
        expect(gate).toBeGreaterThan(-1);
        expect(caller).toBeGreaterThan(-1);
        expect(write).toBeGreaterThan(-1);
    });

    it('the gate precedes the caller, which precedes the mutation', () => {
        // `computer.getOrCreateDefault` INSERTS a row for a user who has no
        // computer. Refusing after it would create a computer for a principal
        // who may not use the product, then tell them no. MEASURED with the
        // check deleted (`server/api/trpc-access.test.ts`'s mutation): a
        // refused stranger's request reaches
        // `select ... from "ezil_computers" ... order by "slot"`, which is
        // `getOrCreateDefaultComputer`'s first step and the insert's cue.
        expect(gate).toBeLessThan(caller);
        expect(caller).toBeLessThan(write);
    });

    it('and it is not tucked inside the Promise.all or the catch', () => {
        const concurrent = body.indexOf('Promise.all(');
        expect(concurrent).toBeGreaterThan(-1);
        expect(gate).toBeLessThan(concurrent);
    });
});

describe('🔴 the refusal chain terminates at /login', () => {
    it('/ still sends a signed-in visitor to /os', () => {
        // The first link of the chain. Also pinned by `../page-entry.test.ts`.
        expect(code(rootPage)).toMatch(/redirect\(user \? Routes\.OS : Routes\.LOGIN\)/);
    });

    it('/login performs no redirect of its own', () => {
        expect(code(loginPage)).not.toMatch(/\bredirect\(/);
        expect(code(loginPage)).not.toMatch(/from 'next\/navigation'/);
    });

    it('/login does not even look the visitor up, so it cannot bounce them', () => {
        // A `getUser()` here is the first step towards "signed in? send them
        // to /os", which is the loop. There is nothing on this page that
        // needs to know.
        expect(code(loginPage)).not.toMatch(/getUser\(\)/);
        expect(code(loginPage)).not.toMatch(/createClient\(/);
    });

    it('and it renders the refusal it is sent, with a way out', () => {
        const body = code(loginPage);
        expect(body).toMatch(/OS_ACCESS_NOT_INVITED/);
        expect(body).toMatch(/invite-only/);
        // 🔴 A refused user holds a VALID session. Without this they cannot
        // leave, and every route they try refuses them.
        expect(body).toMatch(/<form action=\{signOut\}>/);
    });

    it('the constant the pages redirect with is the one the gate throws', () => {
        // Belt and braces on the string itself: a rename that half-lands
        // would leave `/login` rendering the sign-in form to a refused user.
        expect(OS_ACCESS_NOT_INVITED).toBe('not_invited');
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
