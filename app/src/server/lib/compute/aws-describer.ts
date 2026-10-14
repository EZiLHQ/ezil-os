/**
 * The read-only EC2 describe the enrollment endpoint needs (C-6 step 3, live
 * check). 🔴 NOT WIRED: it needs the app's AWS caller (Vercel OIDC →
 * AssumeRoleWithWebIdentity, infra app-caller.ts, audience/subject still a
 * TODO there) and an EC2 client (`@aws-sdk/client-ec2`, not a dependency
 * yet). Until both exist this returns null, and every enrollment answers 503
 * `enroll_unavailable` without consuming anything. Never replace it with a
 * check that does not ask EC2.
 */
import type { Ec2EnrollmentDescriber } from './aws-enroll';

export function awsEnrollmentDescriber(): Ec2EnrollmentDescriber | null {
    return null;
}
