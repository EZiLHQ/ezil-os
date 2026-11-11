// Synthetic capability authority for this isolated native test, never production model support.
export const effortRows = ['native-a','native-b'].map(id => ({id,enabled:true,max_input_tokens:100000,max_output_tokens:8192,
  protocols:['openai-responses'],availability:{state:'available',reasons:[]},capabilities:{streaming:false,tool_calling:true},
  effort:{protocol:'openai-responses',values:['low','high'],default:null}}));
export const MAX_PAYLOAD_BYTES=512*1024;
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const only=(x,keys)=>object(x)&&Object.keys(x).every(k=>keys.includes(k));
const text=(x,max=200000)=>typeof x==='string'&&x.length>0&&x.length<=max;
const jsonTree=(x,depth=0)=>depth<32&&(x===null||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x)||typeof x==='string'&&x.length<=200000||Array.isArray(x)&&x.length<=1024&&x.every(v=>jsonTree(v,depth+1))||object(x)&&Object.keys(x).length<=256&&Object.entries(x).every(([k,v])=>!['$ref','$defs','$dynamicRef','$recursiveRef'].includes(k)&&jsonTree(v,depth+1)));
export function validateResponseRequest(body, ops) {
 const fail=reason=>({ok:false,reason});
 if(!object(body))return fail('object_required');
 let bytes;try{bytes=Buffer.byteLength(JSON.stringify(body));}catch{return fail('invalid_json');}
 if(bytes>MAX_PAYLOAD_BYTES)return fail('payload_too_large');
 if(!only(body,['model','input','max_output_tokens','stream','store','tools','tool_choice','reasoning']))return fail('unknown_field');
 if(!effortRows.some(r=>r.id===body.model)||body.stream!==false||body.store!==false||!Number.isInteger(body.max_output_tokens)||body.max_output_tokens<1||body.max_output_tokens>8192)return fail('invalid_envelope');
 // Text-only fixture: actual serializer emits message/string. No fake tool outputs, images or function calls accepted.
 if(!Array.isArray(body.input)||!body.input.length||body.input.length>1024||!body.input.every(x=>only(x,['type','role','content'])&&x.type==='message'&&['system','user','assistant'].includes(x.role)&&text(x.content)))return fail('invalid_input');
 if(body.tools!==undefined){
  if(!Array.isArray(body.tools)||!body.tools.length||body.tools.length>64||!body.tools.every(t=>only(t,['type','name','description','parameters'])&&t.type==='function'&&typeof t.name==='string'&&/^[A-Za-z0-9_-]{1,64}$/.test(t.name)&&(t.description===undefined||typeof t.description==='string'&&t.description.length<=8192)&&object(t.parameters)&&jsonTree(t.parameters))||new Set(body.tools.map(t=>t.name)).size!==body.tools.length||body.tool_choice!=='auto')return fail('invalid_tools');
 }else if(body.tool_choice!==undefined)return fail('invalid_tool_choice');
 const last=body.input.filter(x=>x.role==='user').at(-1);
 const markers=last?.content.match(/\bEZIL_NATIVE_[A-Z0-9_]+\b/g)??[];
 if(markers.length!==1)return fail('unique_marker_required');
 const marker=markers[0],matched=ops.filter(o=>['send','warmup'].includes(o.kind)&&o.text===marker);
 if(matched.length>1)return fail('duplicate_registration');
 const expected=matched[0];
 if(!expected)return fail('unregistered_request');
 if(expected&&body.model!==expected.expectedModel)return fail('wrong_model');
 const effort=expected?.expectedEffort;
 if(effort===undefined||effort===null){if(body.reasoning!==undefined)return fail('implicit_effort');}
 else if(!['low','high'].includes(effort)||!only(body.reasoning,['effort'])||body.reasoning.effort!==effort)return fail('unlisted_or_wrong_effort');
 return {ok:true,marker};
}
export const responseBody=marker=>({object:'response',id:'resp_'+marker,status:'completed',output:[{type:'message',id:'msg_'+marker,role:'assistant',status:'completed',
  content:[{type:'output_text',text:'EZIL_NATIVE_OK '+marker,annotations:[]}]}],usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}});
