/**
 * The tools this connector exposes, as data.
 *
 * Kept separate from the transport so they can be tested by calling them, with
 * a stub client, rather than by driving a stdio server. `server.ts` does
 * nothing but register these.
 *
 * ## Scope, and what is deliberately absent
 *
 * These are **computer lifecycle** tools: list, create, rename, delete, and
 * mint a URL for a desktop. There are deliberately **no browser-automation
 * tools** here — no navigate, click, type or snapshot. That surface already
 * exists, served by `ezil-works-browser` against this project's container
 * sidecar over a pinned wire contract. Two servers exposing the same verbs is
 * how a contract quietly becomes two contracts, and this repository has already
 * paid for that lesson once (`docs/BROWSER-FIX-CONTRACT.md`).
 */
import { z } from 'zod';
import { EzilError, type Computer, type EzilClient } from '@ezil-os/sdk';

/** What `registerTool` needs, plus the handler. */
export interface ToolDef {
    name: string;
    config: {
        title: string;
        description: string;
        inputSchema?: z.ZodRawShape;
        annotations: {
            readOnlyHint?: boolean;
            destructiveHint?: boolean;
            idempotentHint?: boolean;
            openWorldHint?: boolean;
        };
    };
    handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

export interface ToolResult {
    content: { type: 'text'; text: string }[];
    isError?: boolean;
}

const text = (value: string): ToolResult => ({ content: [{ type: 'text', text: value }] });
const json = (value: unknown): ToolResult => text(JSON.stringify(value, null, 2));

/** A computer, flattened for a model: ISO strings, no nulls-as-surprises. */
const shape = (c: Computer) => ({
    id: c.id,
    name: c.name,
    slot: c.slot,
    createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : c.createdAt,
    lastOpenedAt:
        c.lastOpenedAt instanceof Date ? c.lastOpenedAt.toISOString() : (c.lastOpenedAt ?? null),
    everOpened: c.lastOpenedAt !== null && c.lastOpenedAt !== undefined,
});

/**
 * Turn a failure into something the MODEL can act on.
 *
 * 🔴 An MCP tool error is read by a language model, not by an engineer. A bare
 * stack trace invites a blind retry; the retry costs another container boot and
 * fails identically. So each known failure says what happened AND whether
 * retrying could possibly help.
 */
export const describeError = (err: unknown): ToolResult => {
    if (err instanceof EzilError) {
        if (err.isUnauthorized) {
            return {
                content: [{
                    type: 'text',
                    text: 'Not authorised: EZIL_TOKEN is missing, expired, or belongs to another user. '
                        + 'Retrying will not help — the token has to be replaced by whoever configured this server.',
                }],
                isError: true,
            };
        }
        if (err.isNotFound) {
            return {
                content: [{
                    type: 'text',
                    text: 'No such computer: it does not exist, has been deleted, or belongs to another user. '
                        + 'Call list_computers to see the ids that are actually available.',
                }],
                isError: true,
            };
        }
        if (/timed out/i.test(err.message)) {
            return {
                content: [{
                    type: 'text',
                    text: `${err.message}. A cold container boot is slow (~22s, sometimes far more). `
                        + 'The boot may still be running — call desktop_status before trying again, '
                        + 'because a second open would boot it a second time.',
                }],
                isError: true,
            };
        }
        return { content: [{ type: 'text', text: `${err.path ?? 'request'} failed: ${err.message}` }], isError: true };
    }
    return { content: [{ type: 'text', text: `Unexpected failure: ${String(err)}` }], isError: true };
};

const guard = (fn: (args: Record<string, unknown>) => Promise<ToolResult>) =>
    async (args: Record<string, unknown>): Promise<ToolResult> => {
        try {
            return await fn(args);
        } catch (err) {
            return describeError(err);
        }
    };

const URL_TTL_WARNING =
    'The returned URL is single-use and expires in about five minutes. Give it to the user immediately; '
    + 'do not store it or reuse it later — a stale one opens a blank window with no visible error.';

export const buildTools = (ezil: EzilClient): ToolDef[] => [
    {
        name: 'list_computers',
        config: {
            title: 'List computers',
            description:
                'List the computers belonging to the configured user. Returns id, name, slot and when each '
                + 'was last opened. Deleted computers are never included. Start here — every other tool needs an id.',
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        },
        handler: guard(async () => {
            const computers = await ezil.computers.list();
            if (computers.length === 0) {
                return text('This user has no computers yet. Use create_computer to make one (limit: 2).');
            }
            return json(computers.map(shape));
        }),
    },
    {
        name: 'get_computer',
        config: {
            title: 'Get a computer',
            description: 'Fetch one computer by id.',
            inputSchema: { computerId: z.string().uuid().describe('The computer id, from list_computers.') },
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        },
        handler: guard(async (a) => json(shape(await ezil.computers.get(a.computerId as string)))),
    },
    {
        name: 'create_computer',
        config: {
            title: 'Create a computer',
            description:
                'Create a new computer for the user. A user may hold at most TWO; if they already have two, '
                + 'this fails and the right move is to delete one or reuse an existing one, not to retry.',
            inputSchema: {
                name: z.string().trim().min(1).max(200).optional().describe('Display name. Defaults to "Computer".'),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
        },
        handler: guard(async (a) => {
            const created = await ezil.computers.create(a.name ? { name: a.name as string } : {});
            return json(shape(created));
        }),
    },
    {
        name: 'rename_computer',
        config: {
            title: 'Rename a computer',
            description: 'Change a computer\'s display name. Does not touch the container or the workspace.',
            inputSchema: {
                computerId: z.string().uuid(),
                name: z.string().trim().min(1).max(200),
            },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        handler: guard(async (a) =>
            json(shape(await ezil.computers.rename(a.computerId as string, a.name as string)))),
    },
    {
        name: 'desktop_status',
        config: {
            title: 'Check desktop status',
            description:
                'Cheap poll of whether a computer\'s desktop is currently running. Boots nothing and costs nothing. '
                + 'Use this before open_desktop if you only need to know whether it is already up.',
            inputSchema: { computerId: z.string().uuid() },
            annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
        },
        handler: guard(async (a) => json(await ezil.desktop.status(a.computerId as string))),
    },
    {
        name: 'open_desktop',
        config: {
            title: 'Open the desktop',
            description:
                'Start or attach the computer\'s Linux desktop and return a URL a human can open in a browser. '
                + '🔴 This is a COLD BOOT when the container is not already running: expect ~22 seconds and '
                + `sometimes much longer. Call it once and wait; do not call it again while it is working. ${URL_TTL_WARNING}`,
            inputSchema: { computerId: z.string().uuid() },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        handler: guard(async (a) => json(await ezil.desktop.open(a.computerId as string))),
    },
    {
        name: 'open_editor',
        config: {
            title: 'Open the editor',
            description:
                `Return a URL for code-server (VS Code) running inside the computer's container. ${URL_TTL_WARNING}`,
            inputSchema: { computerId: z.string().uuid() },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        handler: guard(async (a) => json(await ezil.desktop.codeUrl(a.computerId as string))),
    },
    {
        name: 'open_app_preview',
        config: {
            title: 'Open the app preview',
            description:
                'Return a URL for whatever dev server is listening inside the computer\'s container, so a web app '
                + `being built in there can be viewed directly rather than through the streamed screen. ${URL_TTL_WARNING}`,
            inputSchema: { computerId: z.string().uuid() },
            annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        },
        handler: guard(async (a) => json(await ezil.desktop.appPreviewUrl(a.computerId as string))),
    },
    {
        name: 'restart_desktop',
        config: {
            title: 'Restart the desktop',
            description:
                'Re-run the boot script inside the computer\'s EXISTING container. Running applications are stopped; '
                + 'the workspace on disk is not touched. 🔴 This does NOT pick up a new container image — a container '
                + 'keeps the image it was created with until it actually stops.',
            inputSchema: { computerId: z.string().uuid() },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        },
        handler: guard(async (a) => {
            await ezil.desktop.restart(a.computerId as string);
            return text('Restart requested. The desktop takes a few seconds to come back — poll desktop_status.');
        }),
    },
    {
        name: 'delete_computer',
        config: {
            title: 'Delete a computer',
            description:
                'Delete a computer and terminate its container. 🔴 DESTRUCTIVE — confirm with the user first, by id '
                + 'and by name. The workspace is flushed to storage first and the record is soft-deleted, but the '
                + 'computer disappears from the user\'s list and its slot is freed.',
            inputSchema: {
                computerId: z.string().uuid(),
                confirm: z
                    .literal(true)
                    .describe('Must be true. Set it only after the user has explicitly confirmed this deletion.'),
            },
            annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
        },
        handler: guard(async (a) => {
            if (a.confirm !== true) {
                return {
                    content: [{ type: 'text', text: 'Refused: `confirm` must be true, and only after the user has agreed.' }],
                    isError: true,
                };
            }
            await ezil.computers.delete(a.computerId as string);
            return text(`Computer ${String(a.computerId)} deleted and its container terminated.`);
        }),
    },
];
