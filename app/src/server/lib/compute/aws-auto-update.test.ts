import { describe, expect, it } from 'vitest';
import { handleImageRebase } from './aws-rebase-orchestrator';
import { rebaseSetup } from './aws-rebase.test-support';

function setup() {
    const s = rebaseSetup();
    const advance = (overrides: { ownerUserId?: string; allowStart?: boolean; canBoot?: () => Promise<boolean> } = {}) =>
        handleImageRebase(s.deps, { schemaVersion: 1, operation: 'prepare', computerId: s.source.computerId, jobId: null },
            { ownerUserId: s.owner, allowStart: true, canBoot: async () => true, ...overrides });
    return { ...s, advance };
}

describe('automatic image updates on owner open', () => {
    it('reuses one job across opens and waits for the verified snapshot before launch', async () => {
        const s = setup();
        const first = await s.advance();
        expect(first.body).toMatchObject({ eligible: true, phase: 'fencing' });
        expect(first.body.jobId).not.toBeNull();
        expect((await s.advance({ allowStart: false })).body.jobId).toBe(first.body.jobId);
        expect(s.started).toHaveLength(1);
        await s.completePreparation();
        expect((await s.advance({ allowStart: false })).body.phase).toBe('snapshot_ready');
        expect(s.started).toHaveLength(1);
        expect((await s.advance({ allowStart: false })).body.phase).toBe('launch_pending');
        expect(s.started).toHaveLength(2);
    });

    it('cannot create work without an owner open, or after billing refuses it', async () => {
        const s = setup();
        expect((await s.advance({ allowStart: false })).body.jobId).toBeNull();
        expect((await s.advance({ ownerUserId: '11111111-1111-4111-8111-111111111111' })).body.jobId).toBeNull();
        expect((await s.advance({ canBoot: async () => false })).body.jobId).toBeNull();
        expect(s.started).toHaveLength(0);
    });

    it('does not advance a job started by an operator', async () => {
        const s = setup();
        await s.run('prepare');
        await s.completePreparation();
        expect((await s.advance()).body.jobId).toBeNull();
        expect(s.started).toHaveLength(1);
        expect((await s.current()).phase).toBe('fencing');
    });

    it('does not reserve a volume whose previous host has no retirement proof', async () => {
        const s = setup();
        s.provider.sourceListed = false;
        expect((await s.advance()).body).toMatchObject({ jobId: null, failureCode: 'source_identity_mismatch' });
        expect(s.started).toHaveLength(0);
    });
});
