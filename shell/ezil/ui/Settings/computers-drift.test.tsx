/**
 * computers-drift.test.tsx — 🔴 GUARANTEE #2.
 *
 * Run:
 *   cd app && bunx vitest run --config ../shell/ezil/ui/Settings/computers-drift.vitest.config.ts
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * The Settings window moves computer management INTO the OS. That is only
 * safe while `/computers` still works, because `/computers` is the escape
 * hatch: if the shell bundle fails to boot — and this project has already had
 * three separate hydration incidents that ended with an empty `/os` — the OS
 * Settings window is unreachable by definition, and a user at the 2-computer
 * cap with two broken computers has no way to delete either one. `/computers`
 * is the surface that is still there when the shell is not.
 *
 * So this test does not check the Settings window. It checks that the
 * FALLBACK still renders and still reaches Delete, and it is deliberately
 * written to fail if a future task "cleans up" `/computers` on the grounds
 * that the OS has taken over.
 *
 * It renders the real `/computers` page component with `react-dom/server` —
 * no route-manifest string matching, no "the file still exists" assertion.
 * Those pass right up until the moment the component throws.
 *
 * The tRPC client, the toast library and the Next router are stubbed, because
 * this asks what the page renders for a given server answer, not whether the
 * server answers. Everything else — `SelectComputers`, `ComputerRow`,
 * `DeleteComputerDialog`, `delete-copy.ts`, `MAX_COMPUTERS_PER_USER` — is the
 * real module.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../app');

const rows = [
    { id: 'c-1', name: 'Alpha', slot: 1, createdAt: new Date('2026-07-01T00:00:00Z'), lastOpenedAt: null },
];

/** The shape `select-computers.tsx` actually uses off `api`. */
vi.mock('@/trpc/react', () => {
    const query = () => ({ data: rows, isLoading: false, error: null, refetch: () => undefined });
    const mutation = () => ({ mutateAsync: async () => undefined, isPending: false });
    return {
        api: {
            useUtils: () => ({ computer: { list: { invalidate: async () => undefined } } }),
            computer: {
                list: { useQuery: query },
                create: { useMutation: mutation },
                delete: { useMutation: mutation },
            },
        },
    };
});
vi.mock('sonner', () => ({ toast: { error: () => undefined, success: () => undefined } }));
// `next/navigation` is stubbed by ALIAS in the config, not here — see
// `next-navigation.stub.ts` for why `vi.mock` cannot reach it from a test file
// outside vitest's root.

describe('/computers survives the move of computer management into the OS', () => {
    it('the route module still exists and still default-exports a component', async () => {
        const mod = await import('@/app/computers/page');
        expect(typeof mod.default).toBe('function');
    });

    it('🔴 renders — the whole point of the escape hatch', async () => {
        const { default: Page } = await import('@/app/computers/page');
        const html = renderToStaticMarkup(<Page />);
        expect(html.length).toBeGreaterThan(200);
        expect(html).toContain('Your computers');
    });

    it('🔴 renders one row per slot, up to the cap, filled or empty', async () => {
        const { default: Page } = await import('@/app/computers/page');
        const { MAX_COMPUTERS_PER_USER } = await import('@/utils/constants');
        const html = renderToStaticMarkup(<Page />);

        // The live computer is shown...
        expect(html).toContain('Alpha');
        // ...and the free slot offers a way to fill it, so a user who deleted
        // their way out of the cap can get back to two.
        expect(html).toMatch(/New computer/i);
        expect(MAX_COMPUTERS_PER_USER).toBe(2);
    });

    it('🔴 still reaches Delete — the one action the OS cap depends on', async () => {
        const { default: Page } = await import('@/app/computers/page');
        const html = renderToStaticMarkup(<Page />);

        // Delete lives behind the row's overflow menu, and the menu's items
        // are behind `useState(false)` — so the word "Delete" is correctly
        // absent from the first paint. What must be present is the control
        // that opens it, on the row that has a computer in it.
        expect(html).toContain('data-testid="computer-row-menu-button"');
        expect(html).toContain('aria-haspopup="menu"');

        // …and the dialog it leads to must render, with the shared copy in it.
        // Rendered directly because a static render cannot open a menu; this
        // is the terminal UI of the delete path and it is a pure component.
        const { DeleteComputerDialog } = await import('@/app/computers/_components/delete-computer-dialog');
        const { deleteComputerCopy } = await import('@/app/computers/_lib/delete-copy');
        const copy = deleteComputerCopy({ name: 'Alpha', slot: 1 });
        const dialog = renderToStaticMarkup(
            <DeleteComputerDialog
                name="Alpha"
                slot={1}
                isDeleting={false}
                onCancel={() => undefined}
                onConfirm={() => undefined}
            />,
        );
        expect(dialog).toContain(copy.confirmLabel);
        expect(dialog).toContain(copy.cancelLabel);
        expect(dialog).toContain('Alpha');
    });

    it('🔴 the confirmation copy is the SAME module the OS Settings window imports', async () => {
        // Settings (`shell/ezil/ui/Settings/tabs/computers.js`) imports this
        // exact function. If it is renamed, moved or forked, the shell's
        // import breaks the shell build — but the shell build is a separate
        // command, so assert the contract here too.
        const { deleteComputerCopy } = await import('@/app/computers/_lib/delete-copy');
        expect(typeof deleteComputerCopy).toBe('function');
        const copy = deleteComputerCopy({ name: 'Alpha', slot: 1 });
        expect(copy.title).toContain('Alpha');
        expect(copy.confirmLabel).toBeTruthy();
        expect(copy.cancelLabel).toBeTruthy();
        expect(copy.body.length).toBeGreaterThan(0);
    });

    it('both fallback routes are still in the production build', () => {
        // `/computer/[id]` is the other half of the fallback: `/computers`
        // lists them, this opens one. Both are named in the standing rules as
        // things that must keep working.
        //
        // Asserted against the BUILD OUTPUT rather than by importing the page
        // module: `/computer/[id]/page` reaches `@/trpc/server` -> the drizzle
        // client -> `env.ts`, which throws without a real
        // `SUPABASE_DATABASE_URL`. A route that Next actually emitted is
        // better evidence than a module that happened to import anyway.
        const manifestPath = path.resolve(appRoot, '.next/app-path-routes-manifest.json');
        expect(
            fs.existsSync(manifestPath),
            'run `bun run build` in app/ first — this check reads the build output',
        ).toBe(true);
        const routes: Record<string, string> = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const emitted = Object.values(routes);
        expect(emitted).toContain('/computers');
        expect(emitted).toContain('/computer/[id]');
    });

    it('the page and its parts are all still on disk where the route expects them', () => {
        for (const rel of [
            'src/app/computers/page.tsx',
            'src/app/computers/_components/select-computers.tsx',
            'src/app/computers/_components/computer-row.tsx',
            'src/app/computers/_components/delete-computer-dialog.tsx',
            'src/app/computers/_lib/delete-copy.ts',
        ]) {
            expect(fs.existsSync(path.resolve(appRoot, rel)), `${rel} is missing`).toBe(true);
        }
    });
});
