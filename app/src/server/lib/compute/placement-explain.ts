import { awsCanaryConfig, inAwsCanary, isAwsComputersEnabled, type Env } from './aws-config';

export type AwsCanaryExplanation =
    | { eligible: true; reason: 'eligible' }
    | { eligible: false; reason: 'created_before_since'; since: string; createdAt: string }
    | {
          eligible: false;
          reason: 'aws_disabled' | 'canary_unset' | 'canary_malformed' | 'user_not_in_cohort' |
              'computer_missing' | 'computer_deleted' | 'owner_mismatch';
      };

export type AwsCanaryCohortRefusal = 'aws_disabled' | 'canary_unset' | 'canary_malformed' | 'user_not_in_cohort';

/** The flag, config and cohort conditions, which need no database read. Null when all pass. */
export function explainAwsCanaryCohort({ env, userId }: { env: Env; userId: string }): { eligible: false; reason: AwsCanaryCohortRefusal } | null {
    if (!isAwsComputersEnabled(env)) return { eligible: false, reason: 'aws_disabled' };
    if ((env.EZIL_AWS_CANARY_USER_IDS !== undefined && !env.EZIL_AWS_CANARY_USER_IDS.trim()) || !env.EZIL_AWS_CANARY_SINCE?.trim()) {
        return { eligible: false, reason: 'canary_unset' };
    }
    const canary = awsCanaryConfig(env);
    if (!canary) return { eligible: false, reason: 'canary_malformed' };
    if (!inAwsCanary(canary, userId)) return { eligible: false, reason: 'user_not_in_cohort' };
    return null;
}

/** First failed canary condition, without identifiers or admission checks. */
export function explainAwsCanary({ env, userId, computer }: {
    env: Env;
    userId: string;
    /** Validated row with a canonical owner id, as returned by readCanaryComputer. */
    computer: { userId: string; createdAt: Date; deleted: boolean } | null;
}): AwsCanaryExplanation {
    const cohort = explainAwsCanaryCohort({ env, userId });
    if (cohort) return cohort;
    const canary = awsCanaryConfig(env);
    if (!canary) return { eligible: false, reason: 'canary_malformed' }; // unreachable: the cohort check parsed it
    if (computer === null) return { eligible: false, reason: 'computer_missing' };
    if (computer.deleted) return { eligible: false, reason: 'computer_deleted' };
    if (computer.userId !== userId.toLowerCase()) return { eligible: false, reason: 'owner_mismatch' };
    if (computer.createdAt.getTime() < canary.since.getTime()) {
        return { eligible: false, reason: 'created_before_since', since: canary.since.toISOString(), createdAt: computer.createdAt.toISOString() };
    }
    return { eligible: true, reason: 'eligible' };
}
