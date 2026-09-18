'use strict';
for (const action of ['retry', 'copy', 'save']) document.getElementById(action).onclick = async () => {
  try { await window.ezilNative.request(action === 'retry' ? { op: 'retry' } : { op: 'diagnostics', action }); }
  catch { document.getElementById('status').textContent = 'The operation could not complete.'; }
};
