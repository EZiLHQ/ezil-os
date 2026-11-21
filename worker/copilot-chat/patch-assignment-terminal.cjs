// Patch the pinned workbench's native terminal shell-integration boundaries.
// The worker's assignment bridge owns arming and clearing the document scope.
const fs = require('node:fs');

function createAssignmentTerminalProducer(document, window, crypto) {
    const allowedCommands = new Set([
        'pwd', 'whoami', 'ls', 'ls -a', 'ls -l', 'ls -al', 'ls -la', 'ls -lh', 'ls -lah', 'ls -alh',
        'git status', 'git status --short', 'git status --porcelain', 'git diff --stat', 'git rev-parse HEAD',
        'npm test', 'npm run test', 'bun test', 'pnpm test', 'yarn test', 'pytest', 'python -m pytest',
        'python3 -m pytest', 'node --test', 'go test ./...', 'cargo test',
    ]);
    // A live xterm marker is shared by the executed partial command and its
    // finished command. Restored history creates fresh marker objects.
    const running = new WeakMap();
    const assignmentRoot = /^\/workspace\/projects\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[a-z0-9][a-z0-9._-]{0,99}$/;
    const token = /^[a-zA-Z0-9_-]{22}$/;

    function scope() {
        const data = document.documentElement?.dataset;
        if (data?.ezilAssignmentTerminal !== '1') return null;
        const root = data.ezilAssignmentRoot;
        const nonce = data.ezilAssignmentTerminalNonce;
        if (typeof root !== 'string' || assignmentRoot.exec(root)?.[0] !== root
            || root.includes('..') || root.endsWith('.') || root.endsWith('.git')
            || typeof nonce !== 'string' || token.exec(nonce)?.[0] !== nonce) return null;
        return { root, nonce };
    }

    function start(event) {
        try {
            const active = scope();
            const command = event.data;
            const marker = command.commandExecutedMarker;
            if (!active || !marker || typeof marker !== 'object' || running.has(marker)
                || command.wasReplayed === true || command.cwd !== active.root) return;
            running.set(marker, { ...active, terminal: event.instance });
        } catch { /* Evidence cannot interrupt terminal execution. */ }
    }

    function finish(event) {
        try {
            const command = event.data;
            const marker = command.executedMarker;
            const began = running.get(marker);
            if (!began) return;
            running.delete(marker);
            const active = scope();
            if (!active || began.nonce !== active.nonce || began.root !== active.root
                || began.terminal !== event.instance || command.cwd !== active.root
                || command.wasReplayed === true || command.isTrusted !== true
                || command.commandLineConfidence !== 'high') return;
            const known = allowedCommands.has(command.command) ? command.command : null;
            const exitCode = Number.isSafeInteger(command.exitCode) && command.exitCode >= 0 && command.exitCode <= 255
                ? command.exitCode : null;
            const durationMs = Number.isSafeInteger(command.duration) && command.duration >= 0 && command.duration <= 86_400_000
                ? command.duration : null;
            window.dispatchEvent(new CustomEvent('ezil:assignment-terminal', {
                detail: { executionId: crypto.randomUUID(), command: known, exitCode, durationMs },
            }));
        } catch { /* Evidence cannot interrupt terminal execution. */ }
    }

    return { start, finish };
}

const startAnchor = 'this._proxy.$shellExecutionStart(f,I6o(g.instance),g.data.command,y6o(g.data),g.data.isTrusted,g.data.cwd)';
const endAnchor = 'this._proxy.$shellExecutionEnd(f,g.data.command,y6o(g.data),g.data.isTrusted,g.data.exitCode)';
const helperAnchor = 'function y6o(s){switch(s.commandLineConfidence){';
const marker = '/* EZiL assignment terminal evidence */';
const hook = 'ezilAssignmentTerminalProducer';
const patches = [
    [startAnchor, `${hook}.start(g),${startAnchor}`],
    [endAnchor, `${hook}.finish(g),${endAnchor}`],
    [helperAnchor, `${marker}const ${hook}=(${createAssignmentTerminalProducer.toString()})(document,window,globalThis.crypto);${helperAnchor}`],
];

function count(source, literal) {
    return source.split(literal).length - 1;
}

function requireOnce(source, literal, label) {
    if (count(source, literal) !== 1) throw new Error(`assignment terminal patch ${label} must occur exactly once`);
}

function verify(source) {
    requireOnce(source, marker, 'marker');
    for (const [index, [anchor, replacement]] of patches.entries()) {
        requireOnce(source, anchor, `pinned anchor ${index + 1}`);
        requireOnce(source, replacement, `replacement ${index + 1}`);
    }
    return source;
}

function apply(source) {
    if (source.includes(marker)) return verify(source);
    for (const [index, [anchor]] of patches.entries()) requireOnce(source, anchor, `pinned anchor ${index + 1}`);
    for (const [anchor, replacement] of patches) source = source.replace(anchor, () => replacement);
    return verify(source);
}

if (require.main === module) {
    const args = process.argv.slice(2);
    const verifyOnly = args[0] === '--verify';
    if (verifyOnly) args.shift();
    if (args.length !== 1) throw new Error('usage: patch-assignment-terminal.cjs [--verify] <workbench.js>');
    const source = fs.readFileSync(args[0], 'utf8');
    if (verifyOnly) verify(source);
    else {
        const patched = apply(source);
        if (patched !== source) fs.writeFileSync(args[0], patched);
    }
}

module.exports = { apply, verify, createAssignmentTerminalProducer };
