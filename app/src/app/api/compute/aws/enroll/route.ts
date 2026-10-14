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
 * 🔴 The live describe uses the app's AWS caller (Vercel OIDC →
 * AssumeRoleWithWebIdentity on the region's app-caller role, aws-clients.ts).
 * While the AWS flag is off or the caller is unconfigured,
 * `awsEnrollmentDescriber` is null and every enrollment answers 503
 * `enroll_unavailable`; nothing is consumed. Never fake this check.
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
        {
            db, env: process.env, now: () => new Date(), describer: awsEnrollmentDescriber(process.env), tunnels: workerTunnelClientFromEnv(process.env),
            // The app↔Worker HMAC secret also derives each epoch's control key (aws-enroll.ts `deriveControlKey`).
            controlKeySecret: process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '',
        },
        body,
    );
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
