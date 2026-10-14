import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { safeReturnUrl } from '@/utils/constants';

/**
 * `/app/<name>` (the Open in EZiL OS deep link) is `/os` plus a name. These
 * read the sources, in the same spirit as `login/entry-contract.test.ts`: the
 * guarantees live in which document is served and which URL survives sign-in,
 * not in anything a unit can render without a session.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(path.resolve(here, p), 'utf8').replace(/\r\n/g, '\n');
const code = (source: string) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n');

const routePage = code(read('./page.tsx'));
const osPage = code(read('../../os/page.tsx'));
const middleware = code(read('../../../utils/supabase/middleware.ts'));
const appId = new RegExp(/const APP_ID = \/(.+)\/;/.exec(routePage)![1]!);

describe('/app/<name> serves the /os document', () => {
    it('renders the /os page itself, not a copy of it', () => {
        expect(routePage).toMatch(/import OsPage from '\.\.\/\.\.\/os\/page';/);
        expect(routePage).toMatch(/return <OsPage \/>;/);
        expect(routePage).not.toMatch(/bundle\.min\.js|bootPayloadScript/);
    });

    it('is never prerendered or cached, like /os', () => {
        expect(routePage).toMatch(/export const dynamic = 'force-dynamic';/);
    });

    it.each(['code', 'settings', 'app-store', 'secure-browser', 'desktop', 'preview'])('accepts registry id %s', id => {
        expect(appId.test(id)).toBe(true);
    });

    it.each(['Code', '-code', 'code-', 'code--x', '..', 'code.js', 'a b', '%2e%2e', ''])('404s %j, which cannot be a registry id', id => {
        expect(appId.test(id)).toBe(false);
    });

    it('caps the name length before rendering anything', () => {
        expect(routePage).toMatch(/name\.length > 40 \|\| !APP_ID\.test\(name\)\) notFound\(\)/);
    });
});

describe('a signed-out deep link keeps its path and query through sign-in', () => {
    it('the middleware stamps x-return-url from this request, overwriting any client value', () => {
        expect(middleware).toMatch(/requestHeaders\.set\('x-return-url', request\.nextUrl\.pathname \+ request\.nextUrl\.search\)/);
    });

    it('/os returns an /app/ arrival to itself and everything else to /os', () => {
        expect(osPage).toMatch(/const arrival = heads\.get\('x-return-url'\) \?\? '';/);
        expect(osPage).toMatch(/getReturnUrlQueryParam\(arrival\.startsWith\('\/app\/'\) \? arrival : Routes\.OS\)/);
    });

    it('safeReturnUrl lets the deep link back in, query intact', () => {
        const back = '/app/code?task=3f1c2a9e-7b4d-4c1a-9e2f-0a1b2c3d4e5f&ref=refs%2Fheads%2Fmain';
        expect(safeReturnUrl(back)).toBe(back);
    });
});
