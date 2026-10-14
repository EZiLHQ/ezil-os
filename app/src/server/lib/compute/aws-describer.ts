/**
 * The read-only EC2 describe the enrollment endpoint needs (C-6 step 3, live
 * check): `DescribeInstances` / `DescribeVolumes` in the placement's region,
 * with the app caller's short-lived credentials (aws-clients.ts: Vercel OIDC →
 * `AssumeRoleWithWebIdentity` on that region's app-caller role).
 *
 * null while the AWS flag is off or the caller is not configured for every
 * region (`EZIL_AWS_APP_CALLER_ROLE_ARN_<REGION>`): every enrollment then
 * answers 503 `enroll_unavailable` without consuming anything. Never replace it
 * with a check that does not ask EC2.
 */
import type { Env } from './aws-config';
import { sharedAwsSdkCollaborators } from './aws-clients';
import type { Ec2EnrollmentDescriber } from './aws-enroll';

export function awsEnrollmentDescriber(env: Env = process.env): Ec2EnrollmentDescriber | null {
    return sharedAwsSdkCollaborators(env).describer ?? null;
}
