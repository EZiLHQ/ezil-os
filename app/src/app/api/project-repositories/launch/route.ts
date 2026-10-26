import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { launchCode, trustedOrigin } from '@/server/project-repositories/contract';
import { COOKIE_OPTIONS, launchProofCookie, vaults } from '@/server/project-repositories/session';
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
        const intentId = randomBytes(32).toString('base64url');
        const handle = vaults.launches.put({ intentId, code, deadline: Date.now() + 60000 }, Date.now() + 60000);
        const nonce = randomBytes(24).toString('base64url');
        // Only a non-bearer correlation ID reaches the document. A separate,
        // per-intent HttpOnly cookie proves this browser received that intent.
        const html = `<!doctype html><meta charset="utf-8"><form method="post" action="/api/project-repositories/continue"><input type="hidden" name="intentId" value="${intentId}"></form><script nonce="${nonce}">sessionStorage.setItem('ezil.project-launch.pending','${intentId}');document.forms[0].submit();</script>`;
        const response = new NextResponse(html, { status: 200, headers: {
            ...headers, 'content-type': 'text/html; charset=utf-8', 'Referrer-Policy': 'origin',
            'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        } });
        response.cookies.set(launchProofCookie(intentId), handle, { ...COOKIE_OPTIONS, maxAge: 300 });
        return response;
    } catch { return NextResponse.json({ error: 'project_repo_invalid_request' }, { status: 400, headers }); }
}
