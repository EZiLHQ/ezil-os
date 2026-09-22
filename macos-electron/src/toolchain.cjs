'use strict';
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
// Signature verification and xcrun may be slow. They must never run on
// Electron's UI thread, including while Settings is opening.
if (!isMainThread) {
  const xcode = require('./xcode.cjs').discoverXcode();
  const code = require('./vscode.cjs').discover();
  parentPort.postMessage({ xcode, code });
}
let pending, cached, checked = 0;
function queryToolchain() {
  if (cached && Date.now() - checked < 30000) return Promise.resolve(cached);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const worker = new Worker(__filename);
    const timer = setTimeout(() => { void worker.terminate(); reject(Error('Toolchain discovery timed out')); }, 15000);
    worker.once('message', value => { clearTimeout(timer); cached = value; checked = Date.now(); resolve(value); });
    worker.once('error', error => { clearTimeout(timer); reject(error); });
    worker.once('exit', code => { clearTimeout(timer); if (code) reject(Error('Toolchain discovery failed')); });
  }).finally(() => { pending = null; });
  return pending;
}
module.exports = { queryToolchain };
