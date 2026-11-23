import assert from 'node:assert/strict';
import test from 'node:test';
import {openWithAssignmentConsent} from './shell.js';
const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
class Element{
    children=[];hidden=false;isConnected=true;
    setAttribute(){} append(...children){this.children.push(...children);} querySelector(){return null;}
    remove(){this.isConnected=false;}
}
function fixture(url,project,who='owner'){
    const top={},win={location:new URL(url),top,parent:top,addEventListener(){},removeEventListener(){}};
    Object.assign(globalThis,{window:win,document:{createElement:()=>new Element()}});
    const locks=[];let open=0,prepare=0;
    const gate=openWithAssignmentConsent({project,actor:()=>who,computerId:'fixture',body:new Element(),
        park:locked=>locks.push(locked),open:()=>open++,prepare:()=>prepare++});
    return {gate,locks,counts:()=>[open,prepare]};
}
test('mismatched, unresolved or signed-out assignment routes cannot mint Code, including duplicate launches',async()=>{
    const href='https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id;
    for(const [url,project,who] of [
        [href.replace('assignment='+id,'assignment=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),{repoUrl:repo},'owner'],
        [href,{repoUrl:repo},null],
        ['https://os-staging.ezil.work/app/code?assignment='+id+'&repo='+encodeURIComponent('https://github.ezil.work/default/not-the-assignment.git'),{repoUrl:'https://github.ezil.work/default/not-the-assignment.git'},'owner'],
    ]){
        const f=fixture(url,project,who);await Promise.resolve();
        assert.equal(f.gate.locked(),true);assert.equal(f.gate.access(),null);assert.deepEqual(f.counts(),[0,0]);
        assert.ok(f.locks.every(Boolean));await f.gate.close();
    }
});
test('ordinary repository continues through the normal Code launch without media control',async()=>{
    const ordinary='https://github.ezil.work/default/ordinary.git';
    const f=fixture('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(ordinary),{repoUrl:ordinary});
    await Promise.resolve();assert.equal(f.gate,null);assert.deepEqual(f.counts(),[1,0]);assert.deepEqual(f.locks,[]);
});
