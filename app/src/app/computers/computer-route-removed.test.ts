/**
 * `/computer/<uuid>` is removed (2026-11-25). These pins keep it removed, keep
 * every producer in this repository off it, and keep the surfaces that were
 * NOT removed: `/computers` (the list, and the fallback when the shell cannot
 * boot) and the shell's desktop app (`/app/browser`, legacy `/app/desktop`,
 * served through `/api/shell/desktop`).
 *
 * The page was a Server Component, so these are source pins, as
 * `../login/open-access.test.ts` does; the route rules themselves are tested
 * behaviourally in `@/utils/constants.test.ts`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { Routes, SHELL_APP_ALIASES, SHELL_APP_IDS, computerViewerRoute, safeReturnUrl } from '@/utils/constants';

// 🔴 `fileURLToPath`, not `new URL(...).pathname` (win32; see `../login/open-access.test.ts`).
const here = path.dirname(fileURLToPath(import.meta.url));
const appSrc = path.resolve(here, '../..');
const repo = path.resolve(appSrc, '../..');
const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

/** Strip comments, so naming the removed path in prose does not read as building it. */
function code(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
        .join('\n');
}

function sources(root: string, extensions: readonly string[]): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) found.push(...sources(full, extensions));
        else if (extensions.some(ext => entry.name.endsWith(ext)) && !/[.-]test\.[a-z]+$/.test(entry.name)) found.push(full);
    }
    return found;
}

/**
 * A string that IS the removed path or starts it: `'/computer'`,
 * `"/computer/"`, `` `/computer/${id}` ``, `'/computer?x'`, and the
 * `${origin}/computer/${id}` spelling. Not `/computers`, not
 * `/api/trpc/computer.get`, not `/sandbox/computer/migrate`.
 */
const BUILDS_REMOVED_PATH = /(?:['"`]|\$\{[^}]*\})\/computer(?:['"`/?#]|\$\{)/;

describe('🔴 /computer/<uuid> is removed', () => {
    it('the pin itself recognises the removed path and nothing beside it', () => {
        for (const line of [
            "router.push('/computer/' + id)", 'push(`/computer/${id}`)', 'href="/computer"', "COMPUTER: '/computer',",
            'openUrl: `${origin}/computer/${id}`', "'/computer?x=1'",
        ]) {
            expect(BUILDS_REMOVED_PATH.test(line), line).toBe(true);
        }
        for (const line of [
            "COMPUTERS: '/computers',", "fetch('/api/trpc/computer.get')", '`${worker}/sandbox/computer/migrate/${action}`',
            "href='/computers?created=1'", "'/app/browser?computer=' + id",
        ]) {
            expect(BUILDS_REMOVED_PATH.test(line), line).toBe(false);
        }
    });

    it('has no page, layout or route segment left', () => {
        expect(existsSync(path.resolve(appSrc, 'app/computer'))).toBe(false);
        // The client pieces only that page rendered went with it.
        for (const gone of ['cloudflare-guacamole-canvas.tsx', 'desktop-status.tsx', 'capacity-retry.ts']) {
            expect(existsSync(path.resolve(appSrc, 'components/desktop', gone)), gone).toBe(false);
        }
    });

    it('is not a named route, and a sign-in is never returned to it', () => {
        expect(Object.keys(Routes)).not.toContain('COMPUTER');
        expect(Object.values(Routes)).not.toContain('/computer');
        expect(safeReturnUrl('/computer/9d5b0a1e-0000-4000-8000-000000000000')).toBe(Routes.COMPUTERS);
    });

    it('no app or shell source builds the removed path', () => {
        const files = [
            ...sources(appSrc, ['.ts', '.tsx']),
            ...sources(path.resolve(repo, 'shell/ezil'), ['.js', '.ts', '.tsx']),
        ];
        // A scan that silently covers nothing would pass for the wrong reason.
        expect(files.length).toBeGreaterThan(200);
        expect(files.some(file => file.endsWith(path.join('computers', '_components', 'computer-row.tsx')))).toBe(true);
        const offenders = files.filter(file => BUILDS_REMOVED_PATH.test(code(read(file)))).map(file => path.relative(repo, file));
        expect(offenders).toEqual([]);
    });

    it('the tRPC procedure only that page called is gone with it', () => {
        const router = code(read(path.resolve(appSrc, 'server/api/routers/computer.ts')));
        expect(router).not.toMatch(/^\s*touch:\s*protectedProcedure/m);
        // Controls: the procedures the list, the shell and EZiL MCP use are still there.
        for (const procedure of ['list', 'get', 'rename', 'delete', 'getOrCreateDefault']) {
            expect(router, procedure).toMatch(new RegExp(`^\\s*${procedure}:\\s*protectedProcedure`, 'm'));
        }
    });
});

describe('🔴 what a /computers row opens instead', () => {
    const row = code(read(path.resolve(here, '_components/computer-row.tsx')));

    it('loads the shell Browser app on that computer', () => {
        expect(row).toMatch(/const destination = computerViewerRoute\(computer\.id\);/);
        expect(row).toMatch(/window\.location\.assign\(destination\)/);
        expect(computerViewerRoute('9d5b0a1e-0000-4000-8000-000000000000')).toBe(
            '/app/browser?computer=9d5b0a1e-0000-4000-8000-000000000000',
        );
    });

    it('with a document load, never the App Router (the shell only boots on one)', () => {
        expect(row).not.toMatch(/useRouter|router\.(push|replace)|from 'next\/navigation'|from 'next\/link'|<Link\b/);
    });

    it('allows another open when the browser restores the list from history', () => {
        expect(row).toMatch(/window\.addEventListener\('pageshow', resetNavigation\)/);
        expect(row).toMatch(/const resetNavigation = \(\) => \{\s*navigatingRef\.current = false;/);
        expect(row).toMatch(/window\.removeEventListener\('pageshow', resetNavigation\)/);
    });

    it('and an older computer still cannot be opened from the list', () => {
        expect(row).toMatch(/if \(readOnly \|\| navigatingRef\.current\) return;/);
    });
});

describe('what was NOT removed', () => {
    it('/computers keeps its page, its gate and its name', () => {
        expect(Routes.COMPUTERS).toBe('/computers');
        for (const file of ['page.tsx', 'layout.tsx', '_components/select-computers.tsx', '_components/computer-row.tsx']) {
            expect(existsSync(path.resolve(here, file)), file).toBe(true);
        }
        expect(safeReturnUrl('/computers')).toBe('/computers');
    });

    it('the shell desktop app keeps both addresses and its transport', () => {
        expect(SHELL_APP_IDS).toContain('desktop');
        expect(SHELL_APP_ALIASES.browser).toBe('desktop');
        for (const url of ['/app/desktop', '/app/browser', '/app/desktop?computer=9d5b0a1e-0000-4000-8000-000000000000']) {
            expect(safeReturnUrl(url), url).toBe(url);
        }
        expect(existsSync(path.resolve(appSrc, 'app/api/shell/desktop/route.ts'))).toBe(true);
        expect(existsSync(path.resolve(appSrc, 'app/app/[appId]/page.tsx'))).toBe(true);
        expect(existsSync(path.resolve(appSrc, 'app/os/page.tsx'))).toBe(true);
    });
});
