// Synthetic capability authority for this isolated native test, never production model support.
export const effortRows = ['native-a','native-b'].map(id => ({id,enabled:true,max_input_tokens:100000,max_output_tokens:8192,
  protocols:['openai-responses'],availability:{state:'available',reasons:[]},capabilities:{streaming:false,tool_calling:true},
  effort:{protocol:'openai-responses',values:['low','high'],default:null}}));
export function validateResponseRequest(body, ops) {
  const fail=reason=>({ok:false,reason});
  if (!body || typeof body!=='object' || Array.isArray(body)) return fail('object_required');
  if (Object.keys(body).some(k=>!['model','input','max_output_tokens','stream','store','tools','tool_choice','reasoning'].includes(k))) return fail('unknown_field');
  if (!effortRows.some(r=>r.id===body.model) || body.stream!==false || body.store!==false || !Number.isInteger(body.max_output_tokens) || body.max_output_tokens<1 || body.max_output_tokens>8192) return fail('invalid_envelope');
  if (!Array.isArray(body.input) || !body.input.length || body.input.length>1024) return fail('invalid_input');
  const last=body.input.filter(x=>x?.role==='user').at(-1);
  const text=typeof last?.content==='string'?last.content:Array.isArray(last?.content)?last.content.map(x=>x.text??'').join(' '):'';
  const marker=text.match(/\bEZIL_NATIVE_[A-Z0-9_]+\b/)?.[0];
  if (!marker) return fail('synthetic_marker_required');
  const expected=ops.find(o=>o.kind==='send' && o.text===marker);
  if (!expected && marker!=='EZIL_NATIVE_WARMUP') return fail('unregistered_request');
  if (expected && body.model!==expected.expectedModel) return fail('wrong_model');
  const effort=expected?.expectedEffort;
  if (effort===undefined || effort===null) {
    if (body.reasoning!==undefined) return fail('implicit_effort');
  } else if (!['low','high'].includes(effort) || !body.reasoning || Object.keys(body.reasoning).join()!=='effort' || body.reasoning.effort!==effort) return fail('unlisted_or_wrong_effort');
  return {ok:true,marker};
}
export const responseBody=marker=>({object:'response',id:'resp_'+marker,status:'completed',output:[{type:'message',id:'msg_'+marker,role:'assistant',status:'completed',
  content:[{type:'output_text',text:'EZIL_NATIVE_OK '+marker,annotations:[]}]}],usage:{input_tokens:10,output_tokens:5,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}});
