import { NextRequest, NextResponse } from 'next/server';
import { LAUNCH_COOKIE, retainedIdentity, vaults } from '@/server/project-repositories/session';
import { ownedPublicOrigin } from '@/utils/forwarded';
export async function GET(req: NextRequest) {
    const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
    if (req.nextUrl.search || !vaults.launches.get(req.cookies.get(LAUNCH_COOKIE)?.value)) return NextResponse.json({ error: 'project_repo_not_authorized' }, { status: 403, headers });
    let destination = '/os?app=code&projectLaunch=1';
    try { await retainedIdentity(); }
    catch { destination = '/auth/auth0/login?returnUrl=' + encodeURIComponent(destination); }
    const response = NextResponse.redirect(new URL(destination, ownedPublicOrigin(req.headers, req.url)), 303);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
}
