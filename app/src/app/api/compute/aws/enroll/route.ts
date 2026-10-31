import { parseRebaseJson } from '@/server/lib/compute/aws-rebase-json';
import { after, NextResponse } from 'next/server';

import { db } from '@/server/db';
import { awsEnrollmentDescriber } from '@/server/lib/compute/aws-describer';
import { handleAwsEnrollment, workerTunnelClientFromEnv } from '@/server/lib/compute/aws-enroll';
import { logEnrollRefusal } from '@/server/lib/compute/aws-enroll-log';
import { primePoolRelay } from '@/server/lib/compute/aws-pool-session';

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
 *
 * Every non-200 answer is logged once per (computer, error) per minute as `[aws-enroll] refused`
 * (aws-enroll-log.ts): bounded codes and the named computer/epoch only, never the nonce, the
 * identity document, its signature, a key, a token or an address.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' };

export async function POST(req: Request): Promise<Response> {
    let body: unknown;
    try {
        body = parseRebaseJson(await req.text(), 32768);
    } catch {
        logEnrollRefusal({ status: 400, body: { error: 'enroll_request_invalid' } }, null);
        return NextResponse.json({ error: 'enroll_request_invalid' }, { status: 400, headers: NO_STORE });
    }
    let result;
    try {
        result = await handleAwsEnrollment(
            {
                db, env: process.env, now: () => new Date(), describer: awsEnrollmentDescriber(process.env), tunnels: workerTunnelClientFromEnv(process.env),
                // The app↔Worker HMAC secret also derives each epoch's control key (aws-enroll.ts `deriveControlKey`).
                controlKeySecret: process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '',
            },
            body,
        );
    } catch {
        // An unexpected failure (a database read, an ambiguous consume) is retryable, never an
        // unstructured 500: before the consume the nonce check repeats, after it the pending
        // path finishes the same enrollment (aws-enroll.ts). The host keeps its nonce.
        result = { status: 503, body: { error: 'enroll_unavailable', retryable: true } };
    }
    if (result.status !== 200) logEnrollRefusal(result, body);
    if (result.status === 200 && result.poolRelay) {
        const enrollment = result.poolRelay;
        try { after(() => primePoolRelay({ db, env: process.env }, enrollment)); }
        catch { /* Scheduling must never turn durable enrollment into a failed response. */ }
    }
    return NextResponse.json(result.body, { status: result.status, headers: NO_STORE });
}
