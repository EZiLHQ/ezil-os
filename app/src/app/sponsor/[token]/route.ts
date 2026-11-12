import type { NextRequest } from 'next/server';
import { sponsorEntryAvailable } from '@/server/auth/sponsor-entry';
import { sponsorLandingResponse } from '../landing';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
    const { token } = await context.params;
    const mixed = request.nextUrl.searchParams.has('coupon') || request.nextUrl.searchParams.has('token');
    return sponsorLandingResponse({ kind: 'token', value: token }, !mixed && await sponsorEntryAvailable(token));
}
