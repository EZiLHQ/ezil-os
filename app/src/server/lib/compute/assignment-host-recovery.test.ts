import { afterEach, describe, expect, it, vi } from 'vitest';
import { assignmentHostNeedsStop } from './assignment-host-recovery';
import { fixtureReleaseRegistry106 } from './aws-rebase-release-registry.test-support';
import type { Ec2EnrollmentView } from './aws-enroll';
import type { Placement } from './placement';

vi.mock('server-only', () => ({}));
const { describeHost } = vi.hoisted(() => ({ describeHost: vi.fn() }));
vi.mock('./aws-clients', () => ({ sharedAwsSdkCollaborators: () => ({ describer: { describeForEnrollment: describeHost } }) }));
afterEach(() => vi.clearAllMocks());
function fixture() {
    const data = fixtureReleaseRegistry106();
    const legacy = { ...data.release105, recipeVersion: '1.0.8', agentCommit: '9e9e789ceb06344a6ff7982d71ea8bc9209c9050' };
    const corrected = { ...data.release106, recipeVersion: '1.0.12', agentCommit: 'd9038defed2f61039ded5b9f9a656c8643c190c9' };
    const entry = { ...data.deployment106, releases: [legacy, corrected] };
    const env = { AWS_STANDALONE_REPO_OPEN_ENABLED:'1', EZIL_AWS_COMPUTERS_ENABLED:'1',
        EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ [entry.region]:entry }).replaceAll('pilot','prd') };
    const p = { computerId:'11111111-1111-4111-8111-111111111111', ownerUserId:'22222222-2222-4222-8222-222222222222',
        instanceId:'i-33333333333333333', volumeId:'vol-44444444444444444', fenceToken:'55555555-5555-4555-8555-555555555555',
        provider:'aws-ec2', state:'RUNNING', region:'ap-south-1', zoneId:'aps1-az1', generation:2, leaseEpoch:3 } as Placement;
    const host = { state:'running', instanceId:p.instanceId!, imageId:legacy.amiId, availabilityZoneId:p.zoneId!,
        tags:{ 'ezil:stage':'prd','ezil:managed-by':'app-computer-platform','ezil:generation':'2',
            'ezil:pool-host':'pool','ezil:computer':p.computerId,'ezil:fence':p.fenceToken! },
        volumes:[{ volumeId:p.volumeId!, deleteOnTermination:false, tags:{} }] } as unknown as Ec2EnrollmentView;
    describeHost.mockResolvedValue(host);
    return { p, host, env, db:{ execute:vi.fn().mockResolvedValue([{matched:1}]) }, corrected };
}
describe('legacy running AWS assignment notice', () => {
    it('requires the live legacy AMI and retained fenced disk in a .12 shared-lower deployment', async () => {
        const { p, env, db }=fixture();
        expect(await assignmentHostNeedsStop(db,p,env)).toBe(true);
        expect(describeHost).toHaveBeenCalledWith(p.region,p.instanceId);
        expect(db.execute).toHaveBeenCalledTimes(1);
    });
    it('ignores an ordinary new host, unknown AMI, wrong tenant/epoch, and a disposable disk', async () => {
        const { p, host, env, db, corrected }=fixture();
        for (const change of [{imageId:corrected.amiId}, {imageId:'ami-0123456789abcdef0'},
            {tags:{...host.tags,'ezil:computer':p.ownerUserId}}, {tags:{...host.tags,'ezil:fence':'invalid'}},
            {tags:{...host.tags,'ezil:generation':'3'}}, {volumes:[{...host.volumes[0],deleteOnTermination:true}]}]) {
            describeHost.mockResolvedValue({...host,...change});
            expect(await assignmentHostNeedsStop(db,p,env)).toBe(false);
        }
        expect(db.execute).not.toHaveBeenCalled();
    });
    it('requires a current target and an active unchanged owned placement', async () => {
        const { p, env, db }=fixture();
        expect(await assignmentHostNeedsStop(db,{...p,state:'STOPPED'},env)).toBe(false);
        expect(await assignmentHostNeedsStop(db,p,{...env,EZIL_AWS_KILL_SWITCH:'1'})).toBe(false);
        expect(await assignmentHostNeedsStop(db,p,{...env,EZIL_AWS_LIFECYCLE_DEPLOYMENTS:env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS.replace('1.0.12','1.0.11')})).toBe(false);
        expect(describeHost).not.toHaveBeenCalled();
        db.execute.mockResolvedValue([]);
        expect(await assignmentHostNeedsStop(db,p,env)).toBe(false);
        describeHost.mockRejectedValue(new Error('provider not available'));
        expect(await assignmentHostNeedsStop(db,p,env)).toBe(false);
    });
});
