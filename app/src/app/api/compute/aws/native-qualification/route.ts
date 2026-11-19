import { db } from '@/server/db';
import { loadAcceptedNativeDeployment } from '@/server/native-session/accepted-policy';
import { handleNativeQualification, signNativeQualificationPlacement } from '@/server/native-session/qualification-placement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The slash-separated computer, owner and EC2 instance pin enables only this placement.
// The epoch-key proof is verified in the same read-only snapshot that signs the reply.
export async function POST(request: Request): Promise<Response> {
    const accepted = loadAcceptedNativeDeployment(process.env);
    return handleNativeQualification(request, {
        target: process.env.EZIL_NATIVE_QUALIFICATION_TARGET,
        controlSecret: process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET,
        deployment: accepted.state === 'ready' ? accepted.deployment : null,
        sign: (bytes, options) => db.transaction(tx => signNativeQualificationPlacement(bytes, {
            ...options, db: tx, now: () => new Date(),
        }), { accessMode: 'read only', isolationLevel: 'repeatable read' }),
    });
}
