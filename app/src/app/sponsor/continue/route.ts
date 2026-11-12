import { type NextRequest, NextResponse } from 'next/server';
import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, buildAuthorizeUrl } from '@/server/auth/auth0';
import { sponsorCouponEntryAvailable, sponsorEntryAvailable } from '@/server/auth/sponsor-entry';
import { sponsorEntryFromForm } from '@/server/auth/sponsor-entry-input';
import { ownedPublicOrigin } from '@/utils/forwarded';

const MAX_BYTES = 2048;
const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
/** Bound actual streamed bytes too: Content-Length can be absent or dishonest. No database or auth until the whole bounded form is valid. */
async function readForm(request: NextRequest): Promise<URLSearchParams> {
    if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/x-www-form-urlencoded' || !request.body) throw new Error('unavailable');
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0, text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_BYTES) throw new Error('unavailable');
            text += decoder.decode(value, { stream: true });
        }
        return new URLSearchParams(text + decoder.decode());
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally { reader.releaseLock(); }
}
export async function POST(request: NextRequest) {
    const origin = ownedPublicOrigin(request.headers, request.url);
    const length = request.headers.get('content-length');
    // Browser-only form handoff: missing Origin is refused, before body/auth/DB access.
    if (request.headers.get('origin') !== origin || (length !== null && (!/^[0-9]{1,10}$/.test(length) || Number(length) > MAX_BYTES))) {
        return new NextResponse(null, { status: 403, headers: PRIVATE_HEADERS });
    }
    let response: NextResponse;
    try {
        const selection = sponsorEntryFromForm(await readForm(request));
        if (!selection) throw new Error('unavailable');
        const available = selection.kind === 'token' ? await sponsorEntryAvailable(selection.value) : await sponsorCouponEntryAvailable(selection.value);
        if (!available) throw new Error('unavailable');
        // Both inputs resolve afresh on the server. Only the existing signed state/nonce/PKCE reaches the provider.
        const url = await buildAuthorizeUrl({ origin, ...(selection.kind === 'token' ? { sponsorToken: selection.value } : { sponsorCoupon: selection.value }) });
        response = NextResponse.redirect(url, 303);
    } catch {
        response = NextResponse.redirect(new URL('/login?error=sponsor_unavailable', origin), 303);
        response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
    }
    for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
    return response;
}
