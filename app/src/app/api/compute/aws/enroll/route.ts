import { NextResponse } from 'next/server';

import { db } from '@/server/db';
import { awsEnrollmentDescriber } from '@/server/lib/compute/aws-describer';
import { handleAwsEnrollment, workerTunnelClientFromEnv } from '@/server/lib/compute/aws-enroll';

/**
 * `POST /api/compute/aws/enroll`: C-6 host enrollment (docs/AWS-COMPUTERS.md;
 * logic in `aws-enroll.ts`). Called by the host agent (`enroll.py`), never by a
 * browser: no session, no cookie. The one-time nonce, the identity-document
 * signature and a live EC2 describe are the authority.
 *
 * 🔴 The live describe needs the app's AWS caller (Vercel OIDC →
 * AssumeRoleWithWebIdentity, app-caller.ts) and an EC2 client, which are not
 * wired yet: until `awsEnrollmentDescriber` returns one, every enrollment answers 503
 * `enroll_unavailable` and nothing is consumed. Never fake this check.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(req: Request): Promise<Response> {
    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'enroll_request_invalid' }, { status: 400, headers: NO_STORE });
    }
    const result = await handleAwsEnrollment(
        { db, env: process.env, now: () => new Date(), describer: awsEnrollmentDescriber(), tunnels: workerTunnelClientFromEnv(process.env) },
        body,
    );
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
