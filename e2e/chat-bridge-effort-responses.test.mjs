import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateResponseRequest} from './chat-bridge-effort-responses.mjs';
const op={kind:'send',text:'EZIL_NATIVE_A',expectedModel:'native-a',expectedEffort:'low'};
const body=()=>({model:'native-a',input:[{type:'message',role:'user',content:'EZIL_NATIVE_A'}],max_output_tokens:100,stream:false,store:false,reasoning:{effort:'low'}});
test('accepts only matching registered synthetic model/effort request',()=>{assert.equal(validateResponseRequest(body(),[op]).ok,true);assert.equal(validateResponseRequest(body(),[]).ok,false);});
test('rejects cross-session effort and unlisted token',()=>{for(const effort of ['high','max',''])assert.equal(validateResponseRequest({...body(),reasoning:{effort}},[op]).ok,false);});
test('no override requires absent reasoning, never implicit default',()=>{const o={...op,expectedEffort:null};assert.equal(validateResponseRequest(body(),[o]).reason,'implicit_effort');const b=body();delete b.reasoning;assert.equal(validateResponseRequest(b,[o]).ok,true);});
test('explicit effort cannot silently disappear',()=>{const b=body();delete b.reasoning;assert.equal(validateResponseRequest(b,[op]).ok,false);});
test('unknown fields/model/storage/streaming are refused',()=>{for(const change of [{extra:true},{model:'unlisted'},{store:true},{stream:true},{reasoning:{effort:'low',extra:true}}])assert.equal(validateResponseRequest({...body(),...change},[op]).ok,false);});
test('wrong model cannot borrow another session expected effort',()=>{assert.equal(validateResponseRequest({...body(),model:'native-b'},[op]).reason,'wrong_model');});

test('malformed input/content and tool forms cannot pass',()=>{
 for(const input of [[null,{role:'user',content:[{type:'not-input-text',text:'EZIL_NATIVE_A'}]}],[{type:'message',role:'user',content:'EZIL_NATIVE_A',extra:1}],[{type:'function_call',call_id:'x',name:'x',arguments:'{}'}]])assert.equal(validateResponseRequest({...body(),input},[op]).ok,false);
 for(const tools of ['not-an-array',[null],[{type:'function',name:'x',parameters:[],extra:true}]])assert.equal(validateResponseRequest({...body(),tools,tool_choice:{bogus:true}},[op]).ok,false);
});
test('valid offered function grammar is bounded, no tool execution simulated',()=>{
 const tool={type:'function',name:'read_file',parameters:{type:'object',properties:{path:{type:'string'}}}};
 assert.equal(validateResponseRequest({...body(),tools:[tool],tool_choice:'auto'},[op]).ok,true);
 for(const change of [{tools:[tool,tool],tool_choice:'auto'},{tools:[tool],tool_choice:'required'},{tool_choice:'auto'},{tools:[{...tool,extra:1}],tool_choice:'auto'}])assert.equal(validateResponseRequest({...body(),...change},[op]).ok,false);
});
test('unique markers registration and total payload bound',()=>{
 for(const content of ['EZIL_NATIVE_A EZIL_NATIVE_A','EZIL_NATIVE_A EZIL_NATIVE_B','no marker'])assert.equal(validateResponseRequest({...body(),input:[{type:'message',role:'user',content}]},[op]).ok,false);
 assert.equal(validateResponseRequest(body(),[op,op]).ok,false);
 assert.equal(validateResponseRequest({...body(),input:Array(4).fill({type:'message',role:'user',content:'x'.repeat(150000)})},[op]).reason,'payload_too_large');
});
