import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { db } from '@/server/db';
import { PlacementIntegrityError, readLifecyclePlacement, type PlacementState } from '@/server/lib/compute/placement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Wire contract: infra/app-computers/lib/lifecycle/{contract,aws}.ts.
const AUTHORITY_PATH = '/api/internal/computers/lifecycle-authority';
const MAX_SKEW_SECONDS = 300;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const AuthoritySchema = z.object({
    schemaVersion: z.literal(1),
    computerId: uuid,
    jobId: uuid,
    leaseEpoch: z.number().int().min(1).max(2147483647),
    digest: z.string().regex(HEX_SHA256),
}).strict();

// C-3 / PLACEMENT_TRANSITIONS: only an execution still in flight may act.
const IN_FLIGHT_STATES = new Set<PlacementState>([
    'PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RETIRING',
]);
const NO_STORE = { 'cache-control': 'no-store' };
const refuse = () => Response.json({ authorized: false }, { status: 403, headers: NO_STORE });
const unavailable = () => Response.json({ error: 'authority_unavailable' }, { status: 503, headers: NO_STORE });

export async function POST(req: Request): Promise<Response> {
    // Same 32-byte hex key as Secrets Manager's authoritySecretArn AWSCURRENT.
    const secret = process.env.EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET;
    if (!secret || !HEX_SHA256.test(secret)) return unavailable();

    const timestamp = req.headers.get('x-ezil-workflow-timestamp');
    const signature = req.headers.get('x-ezil-workflow-signature');
    if (req.method !== 'POST' || new URL(req.url).pathname !== AUTHORITY_PATH
        || req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
        || !timestamp || !/^(0|[1-9][0-9]*)$/.test(timestamp)
        || !Number.isSafeInteger(Number(timestamp))
        || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > MAX_SKEW_SECONDS
        || !signature || !HEX_SHA256.test(signature)) return refuse();

    let body: Buffer;
    try {
        body = Buffer.from(await req.arrayBuffer());
    } catch {
        return refuse();
    }
    // Hash the exact received bytes, before parsing or reserializing JSON.
    const expected = createHmac('sha256', Buffer.from(secret, 'hex')).update([
        'ezil-lifecycle-authority-v1', 'POST', AUTHORITY_PATH, timestamp,
        createHash('sha256').update(body).digest('hex'),
    ].join('\n')).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return refuse();

    let input: unknown;
    try {
        input = JSON.parse(body.toString('utf8'));
    } catch {
        return refuse();
    }
    const parsed = AuthoritySchema.safeParse(input);
    if (!parsed.success) return refuse();
    const authority = parsed.data;

    try {
        // Migration-aware: a computer moving to AWS is authorised for its hidden launch intent only.
        const { record } = await readLifecyclePlacement(db, authority.computerId);
        if (!record || record.provider !== 'aws-ec2'
            || record.lifecycleJobId !== authority.jobId
            || record.lifecycleDigest !== authority.digest
            || record.leaseEpoch !== authority.leaseEpoch
            || !IN_FLIGHT_STATES.has(record.state)) return refuse();
    } catch (error) {
        // Corrupt/duplicate placements are refused; a failed read is uncertain.
        return error instanceof PlacementIntegrityError ? refuse() : unavailable();
    }

    // The Lambda requires exact object equality; no additional success fields.
    return Response.json({ authorized: true, ...authority }, { status: 200, headers: NO_STORE });
}
