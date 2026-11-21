// Packaged stdio adapter for the owner-granted workspace attach (workspace-mcp.ts).
// Its only argument is the extension-owned socket path; it executes nothing else.
import { relayWorkspaceMcp } from './workspace-mcp';

const socketPath = process.argv[2];
if (!socketPath || !socketPath.startsWith('/')) {
    process.stderr.write('EZiL workspace MCP is not attached in this Code window.\n');
    process.exitCode = 1;
} else {
    relayWorkspaceMcp(socketPath, process.stdin, process.stdout, process.stderr, code => process.exit(code));
}
