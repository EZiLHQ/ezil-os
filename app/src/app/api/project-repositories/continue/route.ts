import { NextRequest, NextResponse } from 'next/server';
import { resolveLaunchIntent, retainedIdentity, bindLaunchIdentity } from '@/server/project-repositories/session';
import { ownedPublicOrigin } from '@/utils/forwarded';
export async function POST(req: NextRequest) {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    const origin = ownedPublicOrigin(req.headers, req.url);
    if (req.nextUrl.search || req.headers.get('origin') !== origin
        || !/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(req.headers.get('content-type') ?? '')) return NextResponse.json({error:'project_repo_invalid_request'},{status:400,headers});
    try {
        const raw = await req.text(); if (raw.length > 128) throw new Error();
        const fields = new URLSearchParams(raw);
        if ([...fields.keys()].length !== 1 || !fields.has('intentId')) throw new Error();
        const intentId = fields.get('intentId')!;
        await resolveLaunchIntent(intentId);
        let destination = '/os?app=code&projectLaunch=1';
        const identity = await retainedIdentity().catch(() => null);
        if (identity) await bindLaunchIdentity(intentId, identity);
        else destination = '/auth/auth0/login?returnUrl=' + encodeURIComponent(destination);
        const response = NextResponse.redirect(new URL(destination, origin), 303);
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
        return response;
    } catch { return NextResponse.json({error:'project_repo_not_authorized'},{status:403,headers}); }
}
