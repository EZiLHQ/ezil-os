import type { NextRequest } from 'next/server';
import { directSponsorEntry } from '../direct-entry';
export const dynamic = 'force-dynamic';
export async function GET(request: NextRequest, context: { params: Promise<{ token: string }> }) {
    const { token } = await context.params;
    const query = request.nextUrl.searchParams;
    const mixed = query.has('coupon') || query.has('token') || query.toString().length > 2048;
    return directSponsorEntry(request, mixed ? null : { kind: 'token', value: token });
}
