import {test} from 'node:test';
import assert from 'node:assert/strict';
import {safeDiagnostic,diagnosticBuffer} from './chat-bridge-effort-diagnostics.mjs';
test('diagnostics remove URL queries, bearer and known secrets',()=>{
 const text=safeDiagnostic('http://127.0.0.1:18444/?code=private Bearer abc token=private2 fixture-secret',['fixture-secret']);
 for(const secret of ['code=private','abc','private2','fixture-secret'])assert.equal(text.includes(secret),false);
});
test('diagnostics bound both events and text',()=>{
 const buffer=diagnosticBuffer();for(let i=0;i<150;i++)buffer.add('error','x'.repeat(5000));
 assert.equal(buffer.entries.length,100);assert.equal(buffer.entries[0].text.length,2000);
 assert.equal(safeDiagnostic('x'.repeat(20000),[],12000).length,12000);
});
