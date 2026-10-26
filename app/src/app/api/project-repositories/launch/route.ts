import { NextRequest, NextResponse } from 'next/server';
import { launchCode, trustedOrigin } from '@/server/project-repositories/contract';
import { COOKIE_OPTIONS, LAUNCH_COOKIE, vaults } from '@/server/project-repositories/session';
import { ownedPublicOrigin } from '@/utils/forwarded';
export async function POST(req: NextRequest) {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (req.nextUrl.search || !trustedOrigin(req.headers.get('origin'), process.env.PROJECT_REPO_CALLER_ORIGINS)
        || !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers.get('content-type') ?? '')) {
        return NextResponse.json({ error: 'project_repo_invalid_request' }, { status: 400, headers });
    }
    try {
        let raw = '';
        const reader = req.body?.getReader(); if (!reader) throw new Error();
        try {
            while (true) { const { done, value } = await reader.read(); if (done) break;
                raw += new TextDecoder().decode(value); if (raw.length > 128) throw new Error(); }
        } finally { await reader.cancel(); }
        const fields = new URLSearchParams(raw);
        if ([...fields.keys()].length !== 1 || !fields.has('code')) throw new Error();
        const code = launchCode.parse(fields.get('code'));
        const handle = vaults.launches.put({ code, deadline: Date.now() + 60000 }, Date.now() + 60000);
        const response = NextResponse.redirect(new URL('/api/project-repositories/continue', ownedPublicOrigin(req.headers, req.url)), 303);
        response.cookies.set(LAUNCH_COOKIE, handle, { ...COOKIE_OPTIONS, maxAge: 28800 });
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        return response;
    } catch { return NextResponse.json({ error: 'project_repo_invalid_request' }, { status: 400, headers }); }
}
