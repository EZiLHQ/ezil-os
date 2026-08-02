import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 Pins the decision documented on `page.tsx`: the root route `/` keeps
 * sending an authenticated visitor to `Routes.COMPUTERS`, NOT `Routes.OS`,
 * even though login itself (`safeReturnUrl`'s empty-input branch) now
 * defaults to the OS.
 *
 * Why this is not the same decision: `/` is reachable by a client-side
 * `<Link href={Routes.HOME}>` — the logo on `/login` — so a `redirect()` here
 * can run as an App Router SOFT navigation, not a document load. `/os` only
 * boots on a document load (see `login/actions.ts`, `entry-contract.test.ts`,
 * docs/PLATFORM-NOTES.md §17); `/computers` is a plain React route, so a soft
 * nav to it is harmless. A future contributor "finishing" the flip by
 * changing this line to `Routes.OS` would reproduce the dead-page defect via
 * a link this file does not control.
 *
 * Reads source, like `login/entry-contract.test.ts`, because the property
 * under test is about which literal this line redirects to, not about
 * behaviour a mocked Supabase client could fake either way.
 */

const here = path.dirname(new URL(import.meta.url).pathname);
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8');

describe('/ (root) does not redirect an authenticated visitor into the OS', () => {
    it('🔴 still redirects to Routes.COMPUTERS, not Routes.OS', () => {
        const source = read('./page.tsx');
        expect(source).toMatch(/redirect\(user \? Routes\.COMPUTERS : Routes\.LOGIN\)/);
    });

    it('the hazard this guards against is real: /login still soft-links to Routes.HOME', () => {
        // If this ever stops being a <Link> (e.g. becomes a plain <a>, or is
        // removed), the guard above is stricter than it needs to be — that's
        // fine, but it means this test's premise should be revisited too.
        const loginSource = read('./login/page.tsx');
        expect(loginSource).toMatch(/<Link href=\{Routes\.HOME\}/);
    });
});
