import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { createTRPCContext } from '@/server/api/trpc';
import { assignmentEnrollmentEnabled } from '@/server/git/assignment-enrollment';
import { Routes, getReturnUrlQueryParam } from '@/utils/constants';

import { AssignmentSignInNotice } from '../../assignment/work-return/sign-in-notice';
import { EnrollmentConsent } from './enrollment-consent';

/**
 * `/app/assignment-enrollment?attempt=<uuid>` — the participant's entry from a Universe assignment (os-staging only).
 *
 * Resumes the participant-owned reservation created by an explicit Universe assignment action. The normal client POSTs `/api/shell/assignment-enrollment`. A static segment, so it wins
 * over `/app/[appId]`.
 */
export const metadata = { title: 'Assignment repository · EZiL OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default async function AssignmentEnrollmentPage({ searchParams }: {
    searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
    if (!assignmentEnrollmentEnabled()) notFound();
    const attempt = (await searchParams ?? {}).attempt;
    if (typeof attempt !== 'string' || !UUID.test(attempt)) notFound();
    const heads = new Headers(await headers());
    heads.set('x-trpc-source', 'rsc-assignment-enrollment');
    const ctx = await createTRPCContext({ headers: heads });
    if (!ctx.user && heads.get('sec-fetch-dest') === 'iframe') return <AssignmentSignInNotice attemptId={attempt} />;
    if (!ctx.user) redirect(`${Routes.LOGIN}?${getReturnUrlQueryParam(`/app/assignment-enrollment?attempt=${attempt}`)}`);
    if (ctx.delegation) notFound();
    return <EnrollmentConsent attemptId={attempt} />;
}
