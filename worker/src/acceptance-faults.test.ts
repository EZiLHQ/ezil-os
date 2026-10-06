import { describe, expect, it } from 'bun:test';
import { assertAcceptanceScope,parseAcceptanceFault,activeAcceptanceFault,failCheckpointWrites } from './acceptance-faults';
const sandbox='guac-abcdef0123456789-fedcba9876543210';
const config={EZIL_ACCEPTANCE_ENV:'staging',EZIL_ACCEPTANCE_SANDBOX:sandbox};
describe('isolated backend fault scope and expiration',()=>{
  it('production, missing scope, malformed scope and other computers fail closed',()=>{
    for(const c of [{},{...config,EZIL_ACCEPTANCE_ENV:'production'},{...config,EZIL_ACCEPTANCE_SANDBOX:'*'}])expect(()=>assertAcceptanceScope(c,sandbox)).toThrow('acceptance_faults_disabled');
    expect(()=>assertAcceptanceScope(config,'guac-other-computer')).toThrow('acceptance_faults_disabled');
    expect(()=>assertAcceptanceScope(config,sandbox)).not.toThrow();
  });
  it('fault duration is bounded and expires without cleanup or clock drift extending it',()=>{
    const state=parseAcceptanceFault({fault:'turn_unavailable',durationMs:5000},1000);
    expect(activeAcceptanceFault(config,sandbox,state,1001)).toBe('turn_unavailable');
    expect(activeAcceptanceFault(config,sandbox,state,6000)).toBeNull();
    expect(activeAcceptanceFault(config,sandbox,state,-100000)).toBeNull();
    expect(activeAcceptanceFault({},sandbox,state,1001)).toBeNull();
    expect(parseAcceptanceFault({fault:'clear'},1000)).toBeNull();
    for(const raw of [null,{}, {fault:'kill_runtime',durationMs:1000},{fault:'turn_unavailable',durationMs:60001},{fault:'turn_unavailable',durationMs:0}])expect(()=>parseAcceptanceFault(raw)).toThrow();
  });
  it('fails actual store writes while preserving bound reads and object identity',async()=>{
    const real={value:3,puts:0,async get(){return this.value},async put(){this.puts++}};
    const store=failCheckpointWrites(real);
    await expect(store.put()).rejects.toThrow('acceptance_checkpoint_write_failed');
    expect(real.puts).toBe(0);expect(await store.get()).toBe(3);
    await real.put();expect(real.puts).toBe(1);
  });
});
