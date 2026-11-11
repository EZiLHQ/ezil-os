// Failure-only bounded diagnostic text. Never record request URLs, headers, cookies or console arguments.
export function safeDiagnostic(value,secrets=[],limit=2000) {
 let text=String(value);
 for(const secret of secrets)if(secret)text=text.split(secret).join('[redacted]');
 return text.replace(/(?:https?|wss?|file):\/\/[^\s<>"']+/gi,'[url]')
  .replace(/Bearer\s+[^\s,"'}]+/gi,'Bearer [redacted]')
  .replace(/((?:access_token|refresh_token|id_token|authorization|api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;}]+/gi,'$1[redacted]')
  .slice(0,limit);
}
export function diagnosticBuffer(secrets=[]) {
 const entries=[];
 return {entries,add(kind,text){if(entries.length<100)entries.push({kind,text:safeDiagnostic(text,secrets)});}};
}
