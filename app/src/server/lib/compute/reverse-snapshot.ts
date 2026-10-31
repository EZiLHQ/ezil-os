/**
 * The D21 snapshot step of a reverse move (AWS → Cloudflare), lane O's seam
 * (docs/compute/REVERSE-MOVE-CONTRACT.md §7.2). Held for v1.
 *
 * - §7.1: in v1 the D21 snapshot is the existing DLM policy. A reverse move never
 *   creates, re-tags or deletes the AWS volume, so DLM keeps snapshotting it after
 *   the export host's retire; committed rows keep `aws_snapshot_id` NULL and the
 *   `snapshot_missing` alert never fires.
 * - §7.3: the post-v1 executor (one of §7.2's two candidates), the `snapshot_missing`
 *   listing through `retention.ts`, and the store calls it will use
 *   (`listUnsnapshotted`, `listRetentionExpired`, `recordSnapshot`, `markSnapshotSpent`).
 *   Each needs its own contract revision first; none has a v1 caller.
 * - §5.4: lane A's `advanceReverseMoves` awaits this first in its pass, before
 *   `claimStale`, with `deadlineMs = passStartedAt + 20_000`, and treats any result
 *   as informational (its pass line logs `snapshot: result.status`).
 *
 * 🔴 NO I/O. This file imports nothing, reads no table, starts nothing, logs
 * nothing and never throws (`reverse-snapshot.test.ts` parses it to hold that).
 * Lane A never writes this file; lane O never writes the driver.
 */

/** DECISION_72 (REVERSE-MOVE-CONTRACT §7.2): lane O is held for v1; the D21 snapshot is the existing DLM policy (§7.1). */
export type ReverseSnapshotPass = { status: 'held'; reason: 'v1_dlm' };
export async function advanceReverseSnapshots(_input: { deadlineMs: number }): Promise<ReverseSnapshotPass> {
    return { status: 'held', reason: 'v1_dlm' };
}
