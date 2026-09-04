import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * 🔴 Pins the decision documented on `page.tsx`: the root route `/` now
 * sends an authenticated visitor into `Routes.OS`, matching login's own
 * default (`safeReturnUrl`'s empty-input branch).
 *
 * This flip is only safe because the one known client-side sender to `/` —
 * the logo on `/login` — is a real `<a href={Routes.HOME}>`, not a Next
 * `<Link>`. A `<Link>` would make `redirect()` here run as an App Router
 * SOFT navigation, and `/os` only boots on a real document load (see
 * `login/actions.ts`, `login/entry-contract.test.ts`,
 * docs/PLATFORM-NOTES.md §17). So this file also pins the sender: if the
 * logo is ever converted back to a `<Link>`, this test (and
 * `login/entry-contract.test.ts`) must fail before the dead-page defect can
 * come back.
 *
 * Reads source, like `login/entry-contract.test.ts`, because the property
 * under test is about which literal this line redirects to and which JSX
 * element sends the request, not about behaviour a mocked Supabase client
 * could fake either way.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8').replace(/\r\n/g, '\n');

describe('/ (root) redirects an authenticated visitor into the OS', () => {
    it('🔴 redirects to Routes.OS, not Routes.COMPUTERS', () => {
        const source = read('./page.tsx');
        expect(source).toMatch(/redirect\(user \? Routes\.OS : Routes\.LOGIN\)/);
    });

    it('this is only safe because /login no longer soft-links to Routes.HOME', () => {
        // If this ever becomes a <Link> again (or gains any other
        // client-side sender to Routes.HOME), the redirect above would run
        // as a soft navigation and `/os` would never boot. See
        // `login/entry-contract.test.ts` for the sender-side assertion.
        const loginSource = read('./login/page.tsx');
        expect(loginSource).toMatch(/<a href=\{Routes\.HOME\}/);
        expect(loginSource).not.toMatch(/<Link[^>]*href=\{Routes\.HOME\}/);
    });
});
