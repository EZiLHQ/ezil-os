import { type NextRequest, NextResponse } from 'next/server';
import { directSponsorEntry } from '../direct-entry';
import { sponsorEntryFromForm, SPONSOR_BILLING_RETURN, type SponsorEntryInput } from '@/server/auth/sponsor-entry-input';
import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS } from '@/server/auth/auth0';
import { SPONSOR_ENTRY_COOKIE, SPONSOR_ENTRY_COOKIE_OPTIONS } from '@/server/auth/sponsor-entry-context';
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
    let selection: SponsorEntryInput | null;
    try { selection = sponsorEntryFromForm(await readForm(request)); }
    catch { selection = null; }
    if (!selection) {
        // Malformed/oversized POSTs remain refused before session, sponsor SQL or OAuth handling.
        const response = NextResponse.redirect(new URL(SPONSOR_BILLING_RETURN + '&coupon_entry=unavailable', origin), 303);
        response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
        response.cookies.set(SPONSOR_ENTRY_COOKIE, '', { ...SPONSOR_ENTRY_COOKIE_OPTIONS, maxAge: 0 });
        for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
        return response;
    }
    // Retained for already-open old invitation forms; the same-origin/actual-byte guards above stay unchanged.
    return directSponsorEntry(request, selection);
}
