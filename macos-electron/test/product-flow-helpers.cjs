'use strict';
const DOWNLOAD = 'EZIL_BROWSER_DOWNLOAD\n';
function assertNativeSession(plist) {
  if (/<key>CGSSessionScreenIsLocked<\/key>\s*<true\s*\/>/.test(plist)) throw Error('macos_screen_locked');
  if (!/<key>kCGSSessionOnConsoleKey<\/key>\s*<true\s*\/>/.test(plist)) throw Error('macos_console_unavailable');
}
const PAGE = `<!doctype html><title>Browser input acceptance</title>
<label>Typing target <input id="typing"></label>
<label>Upload fixture <input id="upload" type="file"></label><pre id="upload-result"></pre>
<a id="download" href="/__ezil_download">Download fixture</a>
<script>document.querySelector('#upload').addEventListener('change', async event => {
document.querySelector('#upload-result').textContent = await event.target.files[0].text();
});</script>`;
function middleware(root, { write = require('node:fs').writeFileSync, delay = setTimeout } = {}) {
  const path = require('node:path');
  return (req, res, next) => {
    if (req.url === '/__ezil_input') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); }
    else if (req.url === '/__ezil_download') {
      res.setHeader('Content-Type', 'text/plain'); res.setHeader('Content-Disposition', 'attachment; filename="ezil-browser-download.txt"'); res.end(DOWNLOAD);
    } else if (req.url === '/__ezil_slow') {
      write(path.join(root, '.e2e-slow-start'), 'started');
      delay(() => { write(path.join(root, '.e2e-slow-end'), 'finished'); res.setHeader('Content-Type', 'text/html'); res.end('<title>Slow complete</title><p>Slow complete</p>'); }, 12000);
    } else next();
  };
}
// Search the launched process's accessibility tree: macOS may expose a dialog
// as a sheet, a dialog window, or nested groups. Never treat exhaustion as success.
function nativeButtonScript(pid, label, seconds = 45) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !['Stop workspace', 'Save', 'Cancel'].includes(label) || !Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw Error('invalid_native_dialog_request');
  return `tell application "System Events"
set deadline to (current date) + ${seconds}
repeat while (current date) < deadline
if exists (first application process whose unix id is ${pid}) then
tell first application process whose unix id is ${pid}
repeat with win in windows
set controls to entire contents of win
repeat with candidateControl in controls
try
if role of candidateControl is "AXButton" and name of candidateControl is "${label}" and enabled of candidateControl then
click candidateControl
return "clicked"
end if
end try
end repeat
end repeat
end tell
end if
delay 0.2
end repeat
error "native_dialog_not_found" number 1001
end tell`;
}
module.exports = { middleware, nativeButtonScript, assertNativeSession, DOWNLOAD };
