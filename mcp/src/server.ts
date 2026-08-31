#!/usr/bin/env bun
/**
 * The EZiL-OS MCP connector.
 *
 * A stdio Model Context Protocol server that exposes one user's computers to an
 * MCP client. It is a **connector**: nothing in `worker/`, `app/` or `shell/`
 * imports it, and EZiL-OS runs identically whether or not it is ever installed.
 *
 * It reaches EZiL-OS only through `@ezil-os/sdk` — no direct HTTP of its own —
 * so there is exactly one client contract to keep true, and the SDK's drift
 * guard covers this server too.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createEzilClient } from '@ezil-os/sdk';

import { ConfigError, readConfig } from './config';
import { buildTools } from './tools';

export const createServer = (
    config: { baseUrl: string; token: string; timeoutMs: number },
    /**
     * Injected only by `server.protocol.test.ts`, which drives this exact
     * server over a real MCP transport and stubs nothing but the network. The
     * production path never passes it.
     */
    fetchImpl?: typeof globalThis.fetch,
): McpServer => {
    const server = new McpServer(
        { name: 'ezil-os', version: '0.1.0' },
        {
            instructions:
                'Manage the configured user\'s EZiL-OS computers: a real Linux container each, with a streamed '
                + 'desktop, an editor and a dev-server preview.\n\n'
                + 'Start with list_computers — every other tool needs an id from it.\n\n'
                + 'Two things to respect. First, open_desktop is a COLD BOOT (~22s, sometimes much longer): call it '
                + 'once and wait, and use desktop_status to check rather than opening again. Second, every URL these '
                + 'tools return expires in about five minutes and is single-use — hand it to the user straight away '
                + 'rather than storing it.\n\n'
                + 'This connector does not drive the browser inside the desktop; it only manages computers.',
        },
    );

    const ezil = createEzilClient({
        baseUrl: config.baseUrl,
        token: config.token,
        timeoutMs: config.timeoutMs,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });

    for (const tool of buildTools(ezil)) {
        server.registerTool(tool.name, tool.config as never, tool.handler as never);
    }

    return server;
};

const main = async (): Promise<void> => {
    let config;
    try {
        config = readConfig(process.env);
    } catch (err) {
        if (err instanceof ConfigError) {
            // 🔴 stderr, and a non-zero exit. A stdio server must never write
            // anything but MCP frames to stdout, and a config problem the host
            // cannot see is a server that looks broken for no reason.
            process.stderr.write(`[ezil-os-mcp] ${err.message}\n`);
            process.exit(2);
        }
        throw err;
    }

    const server = createServer(config);
    await server.connect(new StdioServerTransport());
    process.stderr.write(`[ezil-os-mcp] connected — ${config.baseUrl}\n`);
};

// Only run when executed directly, so tests can import `createServer`.
if (import.meta.main) {
    main().catch((err: unknown) => {
        process.stderr.write(`[ezil-os-mcp] fatal: ${String(err)}\n`);
        process.exit(1);
    });
}
