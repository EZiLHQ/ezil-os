// Stub for `next/navigation` — see computers-drift.vitest.config.ts.
//
// Aliased rather than `vi.mock`'d. OBSERVED: `vi.mock('next/navigation', ...)`
// from a test file OUTSIDE vitest's `root` does not intercept the import made
// by a component INSIDE it — the two resolve the specifier from different
// directories, and Next's export map resolves the in-root one all the way to
// `next/src/client/components/navigation.ts`, a different module id. An alias
// is applied at resolution time and so cannot miss.
//
// `useRouter` outside a mounted app router throws
// "invariant expected app router to be mounted", which says nothing about
// whether `/computers` renders.
export const useRouter = () => ({
    push: () => undefined,
    replace: () => undefined,
    refresh: () => undefined,
    back: () => undefined,
    forward: () => undefined,
    prefetch: () => undefined,
});
export const usePathname = () => '/computers';
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export const redirect = () => undefined;
export const notFound = () => undefined;
