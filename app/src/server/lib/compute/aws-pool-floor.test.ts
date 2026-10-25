import { expect, it, vi } from 'vitest';
import { runPoolReplenish } from './aws-pool-replenish';
import * as data from './ready-pool';
import { fixtureDeployment } from './aws-intent.test-support';
import { poolFixture } from './aws-pool-test-support';
import type { PoolReplenishDeps } from './aws-pool-replenish';

function simulation(cap=14, excess=false, young=false, deferRetirement=false) {
    const f=poolFixture(), deployment=fixtureDeployment('ap-south-1',[...data.POOL_TYPES]);
    let now=new Date('2026-10-25T12:00:00Z'), sequence=0;
    const hosts: (data.PoolHostRow & {createdAt:Date})[]=[];
    const create=(instanceType:data.PoolClass['instanceType'],state:data.PoolHostState='booting')=>{
        const id=`00000000-0000-4000-8000-${String(++sequence).padStart(12,'0')}`;
        const h={...f.row,poolHostId:id,instanceType,state,instanceId:`i-${String(sequence).padStart(17,'0')}`,
            leasedComputerId:null,leasedAt:null,claimGeneration:null,claimLeaseEpoch:null,claimFence:null,claimVolumeSerial:null,
            createdAt:new Date(now),readyAt:new Date(now.getTime()-(young?1:31)*60000)};
        hosts.push(h);return h;
    };
    if(excess){create('m6i.large','ready');create('m6i.large','ready');create('m6i.xlarge','ready');}
    const vcpu=(type:string)=>type==='m6i.large'?2:type==='m6i.xlarge'?4:8;
    const used=()=>hosts.filter(h=>h.state!=='retired').reduce((sum,h)=>sum+vcpu(h.instanceType),0);
    const classes=data.POOL_TYPES.map(instanceType=>({region:deployment.region,zoneId:deployment.zoneId,instanceType,deployment}));
    const deps:PoolReplenishDeps={db:f.deps.db,data:{...data,
        readPoolDemand:async(_tx,c)=>{
            const own=hosts.filter(h=>h.instanceType===c.instanceType);
            return {opens15m:0,activeStandard:c.instanceType==='m6i.large'?26:0,activePremium:c.instanceType==='m6i.large'?0:1,
                bootMinutes:null,spares:own.filter(h=>['ready','booting'].includes(h.state)).length,vcpuInUse:used(),regionVcpuCap:cap,killSwitch:false,
                idleReady:own.filter(h=>h.state==='ready'&&!h.leasedComputerId).map(h=>({poolHostId:h.poolHostId,readyAt:h.readyAt!})),
                booting:own.filter(h=>h.state==='booting').map(h=>({poolHostId:h.poolHostId,createdAt:h.createdAt}))};
        },readPoolReadinessDiagnostics:async()=>[],markPoolHost:async(_tx,id,from,to)=>{
            const h=hosts.find(h=>h.poolHostId===id);if(!h||!from.includes(h.state)||h.leasedComputerId)return null;
            h.state=to;return h;
        }},classes,deployments:{[deployment.region]:deployment},now:()=>now,withLock:run=>run(),log:()=>{},
        starter:{start:vi.fn(async()=>{})},store:{prepare:async(_tx,c,op,build,h)=>{
            if(op==='pool-provision'){expect(used()+vcpu(c.instanceType)).toBeLessThanOrEqual(cap);return build(create(c.instanceType));}
            expect(h?.leasedComputerId).toBeNull();return build(h!);
        },outcome:async(w)=>{const h=hosts.find(h=>h.poolHostId===w.intent.poolHostId)!;h.state=w.intent.operation==='pool-retire'?(deferRetirement?'retiring':'retired'):'ready';}}};
    return {deps,hosts,used,advance:(minutes:number)=>{now=new Date(now.getTime()+minutes*60000);},counts:()=>classes.map(c=>hosts.filter(h=>h.state==='ready'&&h.instanceType===c.instanceType).length)};
}
it('minimums converge over five passes before weighted large surplus with exactly 14 vCPU',async()=>{
    const s=simulation();for(let n=0;n<5;n++)await runPoolReplenish(s.deps);
    expect(s.counts()).toEqual([1,1,1]);expect(s.used()).toBe(14);
});
it('aged idle surplus yields to a missing shape floor without retiring leased hosts',async()=>{
    const s=simulation(14,true);for(let n=0;n<5;n++){
        await runPoolReplenish(s.deps);
        expect(s.counts()[0]).toBeGreaterThanOrEqual(1);
        expect(s.counts()[1]).toBe(1);
    }
    expect(s.counts()).toEqual([1,1,1]);expect(s.used()).toBe(14);
});
it('young surplus waits for the existing idle timer',async()=>{
    const s=simulation(14,true,true);await runPoolReplenish(s.deps);expect(s.counts()).toEqual([2,1,0]);
    s.advance(31);for(let n=0;n<5;n++)await runPoolReplenish(s.deps);expect(s.counts()).toEqual([1,1,1]);
});
it('insufficient regional capacity remains bounded without spending on surplus ahead of missing floors',async()=>{
    const s=simulation(10);for(let n=0;n<5;n++)await runPoolReplenish(s.deps);
    expect(s.used()).toBeLessThanOrEqual(10);expect(s.counts()).toEqual([1,1,0]);
});

it('leased capacity cannot be reclaimed to satisfy an otherwise unaffordable floor',async()=>{
    const s=simulation(14,true);s.hosts[1]!.state='leased';s.hosts[1]!.leasedComputerId='tenant';
    for(let n=0;n<5;n++)await runPoolReplenish(s.deps);
    expect(s.hosts[1]).toMatchObject({state:'leased',leasedComputerId:'tenant'});
    expect(s.counts()).toEqual([1,1,0]);expect(s.used()).toBe(8);
});
it('surplus is allowed once every minimum fits and regional headroom remains',async()=>{
    const s=simulation(16);for(let n=0;n<5;n++)await runPoolReplenish(s.deps);
    expect(s.counts()).toEqual([2,1,1]);expect(s.used()).toBe(16);
});

it('leased vCPU reduces the affordable floor set without deadlocking all new spares',async()=>{
    const s=simulation(14,true);s.hosts[0]!.state='leased';s.hosts[0]!.leasedComputerId='tenant';
    s.hosts[1]!.state='retired';s.hosts[2]!.state='retired';
    for(let n=0;n<5;n++)await runPoolReplenish(s.deps);
    expect(s.counts()).toEqual([1,1,0]);expect(s.used()).toBe(8);
    expect(s.hosts[0]!.state).toBe('leased');
});

it('preserves ready floors on every pass until surplus retirement actually releases capacity',async()=>{
    const s=simulation(14,true,false,true);
    for(let n=0;n<3;n++){
        await runPoolReplenish(s.deps);
        expect(s.counts()).toEqual([1,1,0]);
        expect(s.used()).toBe(8);
        expect(s.hosts.filter(h=>h.state==='retiring').map(h=>h.instanceType)).toEqual(['m6i.large']);
    }
    s.hosts.find(h=>h.state==='retiring')!.state='retired';
    for(let n=0;n<5;n++){
        await runPoolReplenish(s.deps);
        expect(s.counts()).toEqual([1,1,1]);
        expect(s.used()).toBe(14);
    }
});

it.each([
    [0, [0,0,0]], [1, [0,0,0]],
    [2, [1,0,0]], [5, [1,0,0]],
    [6, [1,1,0]], [13, [1,1,0]], [14, [1,1,1]],
] as [number, number[]][])('cap reduction to %i vCPU preserves only affordable minimums',async(cap,expected)=>{
    const s=simulation(cap,true);
    // Begin with one aged, healthy, unleased host in each existing shape.
    s.hosts[1]!.state='retired';
    for(let n=0;n<5;n++)await runPoolReplenish(s.deps);
    expect(s.counts()).toEqual(expected);
    expect(s.used()).toBeLessThanOrEqual(cap);
});
