import type { NextRequest } from 'next/server';
import { sponsorCouponEntryAvailable } from '@/server/auth/sponsor-entry';
import { sponsorCouponFromQuery } from '@/server/auth/sponsor-entry-input';
import { sponsorLandingResponse } from '../landing';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    const coupon = sponsorCouponFromQuery(request.nextUrl.searchParams);
    const available = coupon !== null && await sponsorCouponEntryAvailable(coupon);
    return sponsorLandingResponse(coupon === null ? null : { kind: 'coupon', value: coupon }, available);
}
