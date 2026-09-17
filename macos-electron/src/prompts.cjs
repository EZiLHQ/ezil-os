'use strict';
const { spawn } = require('node:child_process');
const { cleanEnvironment } = require('./vscode.cjs');
// Provider secrets enter through a macOS native password dialog. They are
// returned over a private pipe to main, never through a renderer, argv or env.
function prompt(label, hidden = false) {
  if (process.platform !== 'darwin') throw Error('Provider setup requires macOS');
  if (!/^[A-Za-z0-9 .()/-]+$/.test(label)) throw Error('Invalid prompt');
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/osascript', ['-'], { env: cleanEnvironment(), stdio: ['pipe', 'pipe', 'ignore'], shell: false });
    let output = '', exceeded = false;
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 10000) { exceeded = true; child.kill('SIGTERM'); } });
    child.once('error', () => reject(Error('Native credential dialog unavailable')));
    child.once('exit', code => code === 0 && !exceeded ? resolve(output.trim()) : reject(Error('Provider setup cancelled')));
    child.stdin.end(`set answer to display dialog "${label}" default answer "" ${hidden ? 'with hidden answer' : ''} buttons {"Cancel", "Save"} default button "Save"\nreturn text returned of answer\n`);
  });
}
async function configureProvider(type, vault) {
  if (type === 'remove') { vault.remove(); return; }
  if (type === 'azure') vault.set({ provider: 'azure', endpoint: await prompt('Azure OpenAI or Foundry endpoint'), deployment: await prompt('Azure deployment'), key: await prompt('Azure API key', true) });
  else if (type === 'bedrock') vault.set({ provider: 'bedrock', region: await prompt('Bedrock region'), model: await prompt('Bedrock model ID'), token: await prompt('Bedrock API key', true) });
  else throw Error('Temporary IAM is unavailable');
}
module.exports = { configureProvider };
