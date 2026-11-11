// Both HTTP requests must actually be in flight; no sequential fallback counts as overlap.
export function overlapBarrier(timeoutMs=30000) {
 const groups=new Map();
 return (group,resource)=>new Promise(resolve=>{
  let entry=groups.get(group);
  if(!entry){entry={waiters:[],resources:new Set(),closed:false};groups.set(group,entry);
   entry.timer=setTimeout(()=>{entry.closed=true;for(const w of entry.waiters)w(false);},timeoutMs);}
  if(entry.closed||entry.resources.has(resource)){resolve(false);return;}
  entry.resources.add(resource);entry.waiters.push(resolve);
  if(entry.waiters.length===2){entry.closed=true;clearTimeout(entry.timer);for(const w of entry.waiters)w(true);}
 });
}
