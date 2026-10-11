import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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
  it('power cut parses without a duration and is never a persistent active fault',()=>{
    const state=parseAcceptanceFault({fault:'power_cut'},1000);
    expect(state).toEqual({fault:'power_cut'});
    expect(parseAcceptanceFault({fault:'power_cut',durationMs:5000},1000)).toEqual(state);
    expect(activeAcceptanceFault(config,sandbox,state,1000)).toBeNull();
    expect(activeAcceptanceFault(config,sandbox,state,1001)).toBeNull();
  });
  it('fails actual store writes while preserving bound reads and object identity',async()=>{
    const real={value:3,puts:0,async get(){return this.value},async put(){this.puts++}};
    const store=failCheckpointWrites(real);
    await expect(store.put()).rejects.toThrow('acceptance_checkpoint_write_failed');
    expect(real.puts).toBe(0);expect(await store.get()).toBe(3);
    await real.put();expect(real.puts).toBe(1);
  });
});

// Execute the actual method without loading workerd or the Sandbox SDK.
const source=readFileSync(new URL('./index.ts',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const body=source.match(/  async setAcceptanceFault\(sandboxId: string, raw: unknown\): Promise<void> \{([\s\S]*?)\n  \}/)![1];
const setAcceptanceFault=new Function('assertAcceptanceScope','parseAcceptanceFault',
  `return async function(sandboxId,raw) {${body.replace(/!\./g,'.')}}`)(assertAcceptanceScope,parseAcceptanceFault);

describe('power cut bypasses checkpointing teardown',()=>{
  const fake=()=>{
    const hydrated={workspace:'committed-workspace',system:'committed-system'};
    const calls:string[]=[];
    const forbidden=()=>{throw new Error('checkpoint or storage mutation on power cut');};
    const container={running:true,async destroy(){calls.push('native destroy');this.running=false;}};
    return {env:config,ctx:{container,storage:{put:forbidden,delete:forbidden,deleteAll:forbidden}},
      destroy:forbidden,terminateSandbox:forbidden,stopRuntimeForAcceptance:forbidden,
      runWorkspaceFlush:forbidden,cancelWorkspaceFlushLoop:forbidden,hydrated,calls};
  };
  it('kills through the native binding and leaves hydrated state intact',async()=>{
    const target=fake();
    const before=structuredClone(target.hydrated);
    await setAcceptanceFault.call(target,sandbox,{fault:'power_cut'});
    expect(target.calls).toEqual(['native destroy']);
    expect(target.ctx.container.running).toBe(false);
    expect(target.hydrated).toEqual(before);
  });
  it('refuses production, missing/malformed scope and other sandboxes before killing',async()=>{
    for(const [env,name] of [
      [{},sandbox],[{...config,EZIL_ACCEPTANCE_ENV:'production'},sandbox],
      [{...config,EZIL_ACCEPTANCE_SANDBOX:'*'},sandbox],[config,'guac-other-computer'],
    ] as const){
      const target={...fake(),env};
      await expect(setAcceptanceFault.call(target,name,{fault:'power_cut'})).rejects.toThrow('acceptance_faults_disabled');
      expect(target.calls).toEqual([]);
      expect(target.ctx.container.running).toBe(true);
    }
  });
  it('propagates native destroy failures instead of reporting success',async()=>{
    const target=fake();
    target.ctx.container.destroy=async()=>{throw new Error('native kill failed');};
    await expect(setAcceptanceFault.call(target,sandbox,{fault:'power_cut'})).rejects.toThrow('native kill failed');
  });
});
