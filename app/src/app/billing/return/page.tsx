import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { createTRPCContext } from '@/server/api/trpc';
import { checkoutAvailable, readBillingConfig } from '@/server/billing/config';
import { getReturnUrlQueryParam, Routes } from '@/utils/constants';

import { CheckoutStatus } from './checkout-status';

/** Use the same session gate as computers so the return URL cannot establish ownership. */
export default async function Page({ searchParams }: {
    searchParams: Promise<{ session_id?: string | string[] }>;
}) {
    if (!checkoutAvailable(readBillingConfig())) notFound();
    const ctx = await createTRPCContext({ headers: new Headers(await headers()) });
    const params = await searchParams;
    const sessionId = typeof params.session_id === 'string' ? params.session_id : '';
    if (!ctx.user) {
        const returnUrl = `/billing/return?${new URLSearchParams({ session_id: sessionId })}`;
        redirect(`${Routes.LOGIN}?${getReturnUrlQueryParam(returnUrl)}`);
    }
    return (
        <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-black px-6 text-offwhite">
            <CheckoutStatus sessionId={sessionId} />
            <a href="/os" className="underline">Back to EZiL OS</a>
        </main>
    );
}
