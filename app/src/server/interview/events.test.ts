import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { OS_CLIENT_REPORTED, OS_EVENT_TYPES, turnStartAtISO, validateClientEvent } from './events';

const vectors = JSON.parse(
    readFileSync(new URL('../../../../docs/contracts/interview-evidence-v1.vectors.json', import.meta.url), 'utf8'),
) as { types: { osClientReported: string[]; bySource: { os: string[] } }; turnStartDerivation: { turnEnd: { at: string; durationMs: number }; turnStart: { at: string } } };

const CLIENT_AT = '2026-11-22T09:08:03.900Z';
const turnEnd = (data: Record<string, unknown>) => ({ type: 'agent.turn_end', clientAt: CLIENT_AT, data: {
    requestId: '9d8e7f60-1a2b-4c3d-8e9f-a0b1c2d3e4f5', gatewayRequestId: 'e1d2c3b4-a5f6-4789-8a0b-1c2d3e4f5a6b',
    modelAlias: 'claude-sonnet', durationMs: 6000, outcome: 'completed', toolCalls: { read: 2, search: 1, write: 1, other: 0 }, ...data,
} });

describe('closed type lists match the frozen vectors', () => {
    it('the OS client-reported and full OS type lists are exactly the vectors', () => {
        expect([...OS_CLIENT_REPORTED]).toEqual(vectors.types.osClientReported);
        expect([...OS_EVENT_TYPES]).toEqual(vectors.types.bySource.os);
    });

    // O7: the migration's own `type` CHECK list — read from the SQL file, not the TS mirror — is pinned to the
    // vectors (`types.bySource.os`), so a drift between the DB constraint and the contract fails here. Types are
    // unchanged between vectors 1.0.0 (this worktree) and 1.0.1.
    it('the 0038 type CHECK list is exactly vectors.types.bySource.os', () => {
        const sqlText = readFileSync(new URL('../../../drizzle/0038_interview_evidence.sql', import.meta.url), 'utf8');
        const block = /type text NOT NULL CHECK \(type IN \(([\s\S]*?)\)\)/.exec(sqlText);
        expect(block, 'the ezil_interview_events type CHECK (type IN (...)) block must exist in 0038').not.toBeNull();
        const sqlTypes = [...block![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]);
        expect(sqlTypes).toEqual(vectors.types.bySource.os);
    });
});

describe('turn_start derivation (vectors.turnStartDerivation)', () => {
    it('turn_start.at = turn_end.at - durationMs', () => {
        expect(turnStartAtISO(vectors.turnStartDerivation.turnEnd.at, vectors.turnStartDerivation.turnEnd.durationMs))
            .toBe(vectors.turnStartDerivation.turnStart.at);
        // Positive control: a different duration moves the start.
        expect(turnStartAtISO('2026-11-22T09:08:04.000Z', 1000)).toBe('2026-11-22T09:08:03.000Z');
    });
});

describe('validateClientEvent accepts the exact client-reported shapes', () => {
    it.each([
        ['tab.visibility', { state: 'hidden' }],
        ['window.focus', { focused: false }],
        ['app.focus', { app: 'code' }],
        ['app.focus unknown', { app: 'unknown' }],
        ['presence.idle', { bucket: '<15s' }],
        ['session.heartbeat', {}],
    ])('%s', (label, data) => {
        const type = label.split(' ')[0]!;
        const clean = validateClientEvent({ type, clientAt: CLIENT_AT, data });
        expect(clean).not.toBeNull();
        expect(clean!.type).toBe(type);
        expect(clean!.data).toEqual(data);
    });

    it('agent.turn_end with gatewayRequestId null is valid', () => {
        expect(validateClientEvent(turnEnd({ gatewayRequestId: null }))).not.toBeNull();
    });
});

describe('validateClientEvent rejects everything off-contract (negative, each with its reason)', () => {
    it('a server-only or unknown type is not client-reportable', () => {
        expect(validateClientEvent({ type: 'interview.started', clientAt: CLIENT_AT, data: {} })).toBeNull();
        expect(validateClientEvent({ type: 'agent.turn_start', clientAt: CLIENT_AT, data: { requestId: '9d8e7f60-1a2b-4c3d-8e9f-a0b1c2d3e4f5', derived: true } })).toBeNull();
        expect(validateClientEvent({ type: 'input.idle', clientAt: CLIENT_AT, data: {} })).toBeNull();
    });
    it('a missing / extra / wrong-type data key is rejected', () => {
        expect(validateClientEvent({ type: 'tab.visibility', clientAt: CLIENT_AT, data: {} })).toBeNull();
        expect(validateClientEvent({ type: 'tab.visibility', clientAt: CLIENT_AT, data: { state: 'visible', extra: 1 } })).toBeNull();
        expect(validateClientEvent({ type: 'tab.visibility', clientAt: CLIENT_AT, data: { state: 'away' } })).toBeNull();
        expect(validateClientEvent({ type: 'window.focus', clientAt: CLIENT_AT, data: { focused: 'yes' } })).toBeNull();
        expect(validateClientEvent({ type: 'session.heartbeat', clientAt: CLIENT_AT, data: { x: 1 } })).toBeNull();
        expect(validateClientEvent(turnEnd({ keystrokes: 3 }))).toBeNull();
        expect(validateClientEvent({ type: 'agent.turn_end', clientAt: CLIENT_AT, data: { requestId: '9d8e7f60-1a2b-4c3d-8e9f-a0b1c2d3e4f5' } })).toBeNull();
    });
    it('presence.idle bucket must be one of the four', () => {
        expect(validateClientEvent({ type: 'presence.idle', clientAt: CLIENT_AT, data: { bucket: '5-15m' } })).toBeNull();
        expect(validateClientEvent({ type: 'presence.idle', clientAt: CLIENT_AT, data: { bucket: '<15s' } })).not.toBeNull();
    });
    it('app.focus must match the registry-id pattern', () => {
        expect(validateClientEvent({ type: 'app.focus', clientAt: CLIENT_AT, data: { app: 'Code' } })).toBeNull();
        expect(validateClientEvent({ type: 'app.focus', clientAt: CLIENT_AT, data: { app: 'a'.repeat(65) } })).toBeNull();
    });
    it('turn_end requestId/gatewayRequestId must be lowercase uuids; outcome and durationMs bounded', () => {
        expect(validateClientEvent(turnEnd({ requestId: '9D8E7F60-1A2B-4C3D-8E9F-A0B1C2D3E4F5' }))).toBeNull();
        expect(validateClientEvent(turnEnd({ gatewayRequestId: 'not-a-uuid' }))).toBeNull();
        expect(validateClientEvent(turnEnd({ outcome: 'ok' }))).toBeNull();
        expect(validateClientEvent(turnEnd({ durationMs: -1 }))).toBeNull();
        expect(validateClientEvent(turnEnd({ toolCalls: { read: 2, search: 1, write: 1 } }))).toBeNull();
    });
    it('a clientAt that is not UTC-millisecond, or an extra envelope key, is rejected', () => {
        expect(validateClientEvent({ type: 'session.heartbeat', clientAt: '2026-11-22T09:08:03Z', data: {} })).toBeNull();
        expect(validateClientEvent({ type: 'session.heartbeat', clientAt: CLIENT_AT, data: {}, seq: 1 })).toBeNull();
        expect(validateClientEvent({ type: 'session.heartbeat', data: {} })).toBeNull();
    });
});
