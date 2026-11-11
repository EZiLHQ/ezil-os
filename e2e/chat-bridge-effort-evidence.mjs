import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
// Mandatory final evidence: never let a failed fetch/write leave a successful result receipt.
export async function captureEvidence(out,results,readState,write=writeFileSync) {
 let ok=true;
 try {write(join(out,'fixture-state.json'),JSON.stringify(await readState(),null,2));results.push({name:'required final fixture evidence',ok:true});}
 catch(e){ok=false;results.push({name:'required final fixture evidence',ok:false,error:String(e.message)});}
 write(join(out,'results.json'),JSON.stringify(results,null,2)); // failure must propagate to nonzero exit
 return ok;
}
