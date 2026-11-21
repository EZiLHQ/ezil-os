/** Exact, low-risk spellings. Unknown commands have an execution receipt with a null command. */
export const assessmentTerminalCommands = Object.freeze([
    'pwd', 'whoami', 'ls', 'ls -a', 'ls -l', 'ls -al', 'ls -la', 'ls -lh', 'ls -lah', 'ls -alh',
    'git status', 'git status --short', 'git status --porcelain', 'git diff --stat', 'git rev-parse HEAD',
    'npm test', 'npm run test', 'bun test', 'pnpm test', 'yarn test', 'pytest', 'python -m pytest',
    'python3 -m pytest', 'node --test', 'go test ./...', 'cargo test',
]);
