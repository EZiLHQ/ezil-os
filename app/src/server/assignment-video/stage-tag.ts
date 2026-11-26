import { createHash } from 'node:crypto';

/**
 * The stage correlation tag shared with Universe for one assignment attempt: the first 16 hex of
 * SHA-256(`ezil.assignment.stage.v1` NUL canonical attempt id). It is what a log line carries instead of the attempt.
 */
export function assignmentStageTag(attempt: string): string {
    return createHash('sha256').update('ezil.assignment.stage.v1\0' + attempt, 'utf8').digest('hex').slice(0, 16);
}
