import 'server-only';
import { auth0Enabled } from './auth0';
import { sponsorFromLink } from './sponsor';
import { checkoutAvailable, readBillingConfig } from '@/server/billing/config';
import { sponsorSchemaReady, type SqlRunner } from '@/server/billing/v3/sponsor-store';

/** No database is initialized until an enabled, live campaign and normal checkout are available. */
export async function sponsorEntryAvailable(token: string): Promise<boolean> {
    if (!sponsorFromLink(token) || !auth0Enabled() || !checkoutAvailable(readBillingConfig())) return false;
    try {
        const { db } = await import('@/server/db');
        return await sponsorSchemaReady(db as unknown as SqlRunner);
    } catch { return false; }
}
