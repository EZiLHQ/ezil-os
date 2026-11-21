import { hasBrowserCapability, serveBrowserMcp } from './browser-mcp-stdio';

if (!hasBrowserCapability(process.env)) {
    process.stderr.write('EZiL Browser MCP is unavailable for this Code session.\n');
    process.exitCode = 1;
} else {
    serveBrowserMcp(process.stdin, process.stdout, process.env.EZIL_CODE_BROWSER_MCP_TOKEN!);
}
