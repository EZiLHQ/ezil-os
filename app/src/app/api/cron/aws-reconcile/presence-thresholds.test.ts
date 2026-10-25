/**
 * Documentation pins for the presence signals the minute full reconcile acts on
 * (team/ROOT-IDLE-DOWNSCALE-REVIEW-118.md; docs/AWS-IDLE-PRESENCE-118.md). Real imports
 * where the value is exported, exact source text where it lives in the shell or the
 * Python host agent. A failure here means the documented thresholds changed: update
 * the assessment, not just this test. No behaviour is changed or exercised beyond the
 * pure predicates.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLEET_RECONCILE_LIMIT, sessionLimitFor } from '@/server/lib/compute/aws-receipts';
import { ACTIVITY_FRESH_MS, HEARTBEAT_INTERVAL_MS, isPresent, shouldHeartbeat } from '../../../../../../shell/ezil/activity-heartbeat.js';

const REPO = path.resolve(__dirname, '../../../../../..');
const source = (p: string) => readFileSync(path.join(REPO, p), 'utf8');
const MIN = 60_000;

describe('browser presence (shell/ezil/activity-heartbeat.js)', () => {
    it('beats every 60 s; presence is visible AND focused (fails toward present only when hasFocus is unimplemented)', () => {
        expect(HEARTBEAT_INTERVAL_MS).toBe(MIN);
        expect(isPresent({ visibilityState: 'visible', hasFocus: true })).toBe(true);
        expect(isPresent({ visibilityState: 'visible', hasFocus: undefined })).toBe(true);
        expect(isPresent({ visibilityState: 'visible', hasFocus: false })).toBe(false);
        expect(isPresent({ visibilityState: 'hidden', hasFocus: true })).toBe(false);
    });

    it('a hidden tab sends nothing; a visible unfocused one keeps beating for 30 min after presence, then stops', () => {
        expect(ACTIVITY_FRESH_MS).toBe(30 * MIN);
        expect(shouldHeartbeat({ visible: false, lastPresenceAgoMs: 0 })).toBe(false);
        expect(shouldHeartbeat({ visible: true, lastPresenceAgoMs: 30 * MIN })).toBe(true);
        expect(shouldHeartbeat({ visible: true, lastPresenceAgoMs: 30 * MIN + 1 })).toBe(false);
    });
});

describe('control-plane lease (app)', () => {
    it('renews only from presence fresher than 30 min, to presence + 3600 s, writing once half is used', () => {
        const ec2 = source('app/src/server/lib/compute/aws-ec2.ts');
        expect(ec2).toMatch(/export const AWS_PRESENCE_FRESH_MS = 30 \* 60_000;/);
        expect(ec2).toMatch(/const leaseSeconds = deps\.leaseSeconds \?\? 3600;/);
        expect(ec2).toMatch(/if \(current >= target \|\| \(current > t && current - t > \(leaseSeconds \* 1000\) \/ 2\)\) return p;/);
    });

    it('a RUNNING row is due to stop exactly when lease_until is reached (or absent); the fleet pass claims 20 rows', () => {
        const now = new Date('2026-10-25T12:00:00Z');
        const row = (leaseUntil: Date | null) => ({ state: 'RUNNING', provider: 'aws-ec2', leaseUntil, ownerUserId: 'u' }) as never;
        expect(sessionLimitFor(row(new Date(now.getTime() + 1)), { now, caps: null }, null)).toBeNull();
        expect(sessionLimitFor(row(now), { now, caps: null }, null)).toBe('lease_expired');
        expect(sessionLimitFor(row(null), { now, caps: null }, null)).toBe('lease_expired');
        expect(FLEET_RECONCILE_LIMIT).toBe(20);
    });
});

describe('host edge and agent (infra/host-agent)', () => {
    it('the edge reports presence every 30 s while ANY verified WebSocket is open (throttled to one per 15 s)', () => {
        const edge = source('infra/host-agent/lib/ezil_host/edge.py');
        expect(edge).toMatch(/^WS_PRESENCE_INTERVAL = 30$/m);
        expect(edge).toMatch(/^PRESENCE_MIN_INTERVAL = 15$/m);
        expect(edge).toMatch(/while not stop\.wait\(WS_PRESENCE_INTERVAL\):/);
    });

    it('the guest idles out after 600 s without presence, checked every 30 s; terminal work holds it at most 8 h', () => {
        expect(source('infra/host-agent/lib/ezil_host/config.py'))
            .toMatch(/"idle": \{"inactivitySeconds": 600, "load1Busy": 0\.5, "intervalSeconds": 30,\s*"flushTimeoutSeconds": 120\}/);
        expect(source('infra/host-agent/lib/ezil_host/terminal_work.py')).toMatch(/^TERMINAL_KEEPALIVE_MAX_SECONDS = 8 \* 60 \* 60$/m);
    });
});
