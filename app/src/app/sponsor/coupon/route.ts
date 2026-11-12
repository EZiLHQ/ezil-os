import type { NextRequest } from 'next/server';
import { sponsorCouponFromQuery } from '@/server/auth/sponsor-entry-input';
import { directSponsorEntry } from '../direct-entry';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest) {
    const coupon = sponsorCouponFromQuery(request.nextUrl.searchParams);
    return directSponsorEntry(request, coupon === null ? null : { kind: 'coupon', value: coupon });
}
