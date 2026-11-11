// Driver-only fixture control authority, never an AI or bridge credential.
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const token=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(x);
export function controllerAllowed(headers,secret) {
 return typeof secret==='string'&&secret.length>=32&&headers.authorization===`Bearer ${secret}`&&headers.origin===undefined;
}
export function validEnqueue(s,ops) {
 if(ops.length>=100||!object(s)||!token(s.role)||ops.some(o=>o.role===s.role)||!['create','configure','send'].includes(s.kind))return false;
 const keys=s.kind==='send'?['role','kind','sessionRole','text','expectedModel','expectedEffort','overlapGroup']:['role','kind','sessionRole','model','effort'];
 if(Object.keys(s).some(k=>!keys.includes(k)))return false;
 if(s.kind!=='create'&&(!token(s.sessionRole)||!ops.some(o=>o.role===s.sessionRole&&o.kind==='create'&&o.status==='applied')))return false;
 if(s.kind==='create'&&s.sessionRole!==undefined)return false;
 if(s.kind==='send')return /^EZIL_NATIVE_[A-Z0-9_]{1,64}$/.test(s.text)&&!ops.some(o=>o.text===s.text)&&['native-a','native-b'].includes(s.expectedModel)&&[null,'low','high'].includes(s.expectedEffort)&&(s.overlapGroup===undefined||token(s.overlapGroup));
 return (s.model===undefined||typeof s.model==='string'&&/^[A-Za-z0-9._:/-]{1,256}$/.test(s.model))&&(s.effort===undefined||['low','high'].includes(s.effort))&&(s.model!==undefined||s.effort!==undefined);
}
