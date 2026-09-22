'use strict';
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { noLinks, privateDir, atomic } = require('./files.cjs');
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin';
function createLoginPathLookup({ run = (...args) => childProcess.spawnSync(...args), platform = process.platform } = {}) {
  let cached;
  return () => {
    if (cached !== undefined) return cached;
    cached = '';
    if (platform !== 'darwin') return cached;
    const user = os.userInfo(), shell = user.shell || '/bin/zsh';
    if (!path.isAbsolute(shell) || !['zsh', 'bash', 'sh', 'ksh', 'fish'].includes(path.basename(shell))) return cached;
    let directory, fd;
    try {
      // Startup stdout/stderr are discarded at the OS boundary. FD 3 carries
      // only PATH; never request `env`, tokens, or startup-file contents.
      const command = path.basename(shell) === 'fish' ? 'string join : $PATH >&3' : 'printf "%s" "$PATH" >&3';
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-login-path-'));
      const file = path.join(directory, 'path');
      fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
      const result = run(shell, ['-i', '-l', '-c', command], {
        env: { HOME: os.homedir(), USER: user.username, LOGNAME: user.username, SHELL: shell, PATH: BASE_PATH, LANG: 'en_US.UTF-8' },
        // A regular FD avoids descendants holding a capture pipe open after
        // the shell has timed out. No startup output is ever buffered.
        stdio: ['ignore', 'ignore', 'ignore', fd], encoding: 'utf8', timeout: 1800, killSignal: 'SIGKILL', maxBuffer: 65536,
      });
      if (!result.error && result.status === 0 && fs.fstatSync(fd).size <= 65536) {
        const buffer = Buffer.alloc(65536); const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
        cached = buffer.subarray(0, bytes).toString('utf8').trim();
      }
    } catch { /* Cache failure too; Finder launches must not repeatedly stall. */ }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    }
    return cached;
  };
}
const loginPath = createLoginPathLookup();
const sensitiveVariable = key => /^(?:EZIL_|AZURE_|OPENAI_|ANTHROPIC_|AWS_|GOOGLE_|GEMINI_|GROQ_|MISTRAL_|COHERE_|HF_|HUGGING_FACE_|VERTEX_)/i.test(key) || /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY|BOOTSTRAP|CAPABILITY)/i.test(key);
const TERMINAL_REMOVALS = ['EZIL_BROKER_FILE', 'EZIL_AI_BROKER_FILE', 'EZIL_NATIVE_ADMIN_CAPABILITY', 'OPENAI_API_KEY', 'AZURE_API_KEY', 'AZURE_OPENAI_API_KEY', 'ANTHROPIC_API_KEY'];
function settingsJSON(text) {
  // Replace comments with spaces so source offsets remain usable. Preserve
  // strings, comments and all unrelated settings when inserting the policy.
  const comments = text.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, token => token.startsWith('"') ? token : token.replace(/[^\r\n]/g, ' '));
  const clean = comments.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (token, tail) => tail === undefined ? token : ' ' + tail);
  const value = JSON.parse(clean);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw Error('Invalid profile settings');
  return { value, clean, comments };
}
function configureTerminalEnvironment(workspace, { external = false } = {}) {
  // Accept only the store's app-owned profile layout, never ~/.config/Code.
  if (!path.isAbsolute(workspace.dir) || workspace.editorData !== path.join(workspace.dir, 'editor-data')) throw Error('Invalid app profile');
  noLinks(workspace.dir); noLinks(workspace.editorData);
  const profile = external ? path.join(workspace.editorData, 'external-vscode') : workspace.editorData;
  const directory = privateDir(path.join(profile, 'User')), file = path.join(directory, 'settings.json');
  noLinks(file);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)) throw Error('Invalid profile settings');
  const text = stat ? fs.readFileSync(file, 'utf8') : '{}';
  const { value, clean, comments } = settingsJSON(text), key = 'terminal.integrated.env.osx';
  const previous = value[key] ?? {};
  if (typeof previous !== 'object' || Array.isArray(previous)) throw Error('Invalid terminal environment');
  const merged = { ...previous };
  for (const variable of new Set([...TERMINAL_REMOVALS, ...Object.keys(process.env).filter(sensitiveVariable), ...Object.keys(previous).filter(sensitiveVariable)])) merged[variable] = null;
  const replacement = JSON.stringify(merged, null, 2);
  const tokens = [...clean.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g)];
  let depth = 0, start, end;
  let matches = 0;
  for (let i = 0, level = 0; i < tokens.length; i++) {
    const token = tokens[i][0];
    if (level === 1 && token.startsWith('"') && JSON.parse(token) === key && tokens[i + 1]?.[0] === ':') matches++;
    if (token === '{' || token === '[') level++;
    if (token === '}' || token === ']') level--;
  }
  if (matches > 1) throw Error('Duplicate terminal environment settings');
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i][0];
    if (depth === 1 && token.startsWith('"') && JSON.parse(token) === key && tokens[i + 1]?.[0] === ':') {
      start = tokens[i + 1].index + 1;
      let nested = 0;
      for (let j = i + 2; j < tokens.length; j++) {
        const next = tokens[j][0];
        if (nested === 0 && (next === ',' || next === '}')) { end = tokens[j].index; break; }
        if (next === '{' || next === '[') nested++;
        if (next === '}' || next === ']') nested--;
      }
      break;
    }
    if (token === '{' || token === '[') depth++;
    if (token === '}' || token === ']') depth--;
  }
  let updated;
  if (start !== undefined && end !== undefined) updated = text.slice(0, start) + ' ' + replacement + text.slice(end);
  else {
    const close = clean.lastIndexOf('}');
    const comma = Object.keys(value).length && !comments.slice(0, close).trimEnd().endsWith(',') ? ',' : '';
    updated = text.slice(0, close) + `${comma}\n  "${key}": ${replacement}\n` + text.slice(close);
  }
  if (updated !== text) atomic(file, updated);
}
function developmentEnvironment(resources) {
  const home = os.homedir(), user = os.userInfo().username;
  // Construct an allowlist, never spread the Electron/bootstrap environment.
  const hostPaths = [loginPath(), process.env.PATH || ''].flatMap(value => value.split(path.delimiter)).filter(entry => path.isAbsolute(entry) && !/[\0\r\n]/.test(entry));
  const paths = [...new Set([...hostPaths, path.join(home, '.bun/bin'), path.join(home, '.local/bin'), path.join(home, '.cargo/bin'), '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])];
  if (resources) {
    if (!path.isAbsolute(resources) || resources.includes('\0')) throw Error('Invalid resources directory');
    paths.push(path.join(resources, 'bun'), path.join(resources, 'code-server/lib'));
  }
  return { HOME: home, USER: user, LOGNAME: user, PATH: paths.join(path.delimiter), TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8', SHELL: os.userInfo().shell || '/bin/zsh' };
}
module.exports = { developmentEnvironment, createLoginPathLookup, configureTerminalEnvironment };
