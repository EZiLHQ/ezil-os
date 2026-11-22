import {describe, expect, it} from 'bun:test';
import {runInNewContext} from 'node:vm';
import source from '../scripts/assignment-click-cues.txt';
import {codeFolderBridgeScript} from './code-folder-bridge';

const stage = 'https://os-staging.ezil.work';
const mint = 'A'.repeat(22);
function frame() {
    const events = new Map<string, Function>(), pointers = new Map<string, Function>();
    const timers = new Map<number,{run:Function,ms:number}>();
    let idx=0, painted=0, cleared=0, sent=0;
    const parent={postMessage(){sent++;}};
    const win={parent}, tag={dataset:{ezilFolderBridge:'1'},hasAttribute:()=>false};
    const sandbox = {window:win,parent,location:{search:'?ezil_mint='+mint},URLSearchParams,
        setTimeout:(run:Function,ms:number)=>{timers.set(++idx,{run,ms});return idx;},clearTimeout:(id:number)=>timers.delete(id),
        addEventListener:(t:string,fn:Function)=>events.set(t,fn),
        document:{currentScript:tag,addEventListener:(t:string,fn:Function)=>pointers.set(t,fn),
            removeEventListener:(t:string)=>pointers.delete(t),body:{append(){painted++;}},
            createElement:()=>({style:{},setAttribute(){},remove(){cleared++;}})}};
    runInNewContext(source,sandbox);
    return {send:(origin=stage,binding=mint,active=true,who:object=parent)=>events.get('message')?.({
        source:who,origin,data:{type:'ezil.assignment.click-cues',v:1,binding,active}}),
        click:(trusted=true,secret=false)=>pointers.get('pointerdown')?.({isTrusted:trusted,view:win,
        button:0,clientX:7,clientY:9,target:{closest:(s:string)=>s==='.monaco-workbench'||secret}}),
        expire:()=>{for(const t of [...timers.values()])if(t.ms===3500)t.run();},
        report:()=>({painted,cleared,sent,input:pointers.has('pointerdown')})};
}
describe('first-party assignment visual feedback',()=>{
    it('installs a pointer cue only after an exact staging parent and document binding authorize it',()=>{
        const f=frame();
        f.click(); f.send('https://os.ezil.work'); f.send(stage,'other'); f.send(stage,mint,true,{}); f.click();
        expect(f.report()).toEqual({painted:0,cleared:0,sent:0,input:false});
        f.send(); f.click(false); f.click(true,true);
        expect(f.report()).toEqual({painted:0,cleared:0,sent:0,input:true});
        f.click(); expect(f.report().painted).toBe(1);
        f.send(stage,mint,false); f.click();
        expect(f.report()).toEqual({painted:1,cleared:1,sent:0,input:false});
    });
    it('expires the listener and local marker when the active recorder stops renewing',()=>{
        const f=frame();f.send();f.click();f.expire();f.click();
        expect(f.report()).toEqual({painted:1,cleared:1,sent:0,input:false});
    });
    it('keeps the editor behavior limited to the first-party staging workbench bridge',()=>{
        expect(codeFolderBridgeScript(['https://os.ezil.work'])).not.toContain('ezil.assignment.click-cues');
        expect(codeFolderBridgeScript([stage])).toContain('ezil.assignment.click-cues');
    });
});
