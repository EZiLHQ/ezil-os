// Cross-checks package.json against the source that relies on it: the commands
// the host registers, the settings config.ts reads, the view id, the pinned client.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINNED_OPENCODE_VERSION } from '../src/opencode/version';

const root = join(import.meta.dir, '..');
const source = (relative: string): string => readFileSync(join(root, 'src', relative), 'utf8');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    main: string; dependencies: Record<string, string>; engines: { vscode: string }; enabledApiProposals?: unknown; activationEvents: string[];
    scripts: Record<string, string>;
    contributes: {
        viewsContainers: { secondarySidebar: Array<{ id: string }> }; views: Record<string, Array<{ id: string; type: string }>>;
        commands: Array<{ command: string }>; menus: Record<string, Array<{ command: string }>>; keybindings: Array<{ command: string }>;
        configuration: { properties: Record<string, { type: string; default: unknown }> };
    };
};

test('pins @opencode/client to the exact version the extension expects from opencode serve', () => {
    expect(manifest.dependencies['@opencode/client']).toBe(PINNED_OPENCODE_VERSION);
    expect(PINNED_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test('every command the host registers is contributed, and every contributed/menu/keybinding command is registered', () => {
    const registered = [...source('extension.ts').matchAll(/registerCommand\('([^']+)'/g)].map(match => match[1]!).sort();
    const contributed = manifest.contributes.commands.map(command => command.command).sort();
    expect(registered.length).toBeGreaterThan(0);
    expect(contributed).toEqual(registered);
    const referenced = [...Object.values(manifest.contributes.menus).flat(), ...manifest.contributes.keybindings].map(item => item.command);
    for (const command of referenced) expect(contributed).toContain(command);
});

test('every ezilChat setting config.ts reads is declared with the same default, and nothing else is declared', () => {
    const config = source('config.ts');
    const reads = [...config.matchAll(/text\('(\w+)'(?:, '([^']*)')?\)/g)].map(match => ({ key: match[1]!, fallback: match[2] ?? '' }));
    const flags = [...config.matchAll(/config\.get<boolean>\('(\w+)', (true|false)\)/g)].map(match => ({ key: match[1]!, fallback: match[2] === 'true' }));
    expect(reads.length + flags.length).toBeGreaterThanOrEqual(8);
    const properties = manifest.contributes.configuration.properties;
    for (const { key, fallback } of reads) expect([key, properties[`ezilChat.${key}`]?.type, properties[`ezilChat.${key}`]?.default]).toEqual([key, 'string', fallback]);
    for (const { key, fallback } of flags) expect([key, properties[`ezilChat.${key}`]?.type, properties[`ezilChat.${key}`]?.default]).toEqual([key, 'boolean', fallback]);
    const declared = Object.keys(properties).map(key => key.replace(/^ezilChat\./, '')).sort();
    expect(declared).toEqual([...reads, ...flags].map(item => item.key).sort());
});

test('the webview view id, activation events, entry point and stable-API constraints line up', () => {
    const viewId = /export const VIEW_ID = '([^']+)'/.exec(source('panel/provider.ts'))?.[1];
    expect(viewId).toBeDefined();
    expect(manifest.contributes.views['ezil-chat']).toEqual([expect.objectContaining({ id: viewId, type: 'webview' })]);
    expect(manifest.contributes.viewsContainers.secondarySidebar.map(container => container.id)).toEqual(['ezil-chat']);
    expect(manifest.activationEvents).toContain(`onView:${viewId}`);
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.scripts['build:extension']).toContain('--outfile=dist/extension.js');
    expect(manifest.enabledApiProposals).toBeUndefined();
    expect(manifest.engines.vscode).toMatch(/^\^1\.\d+\.\d+$/);
});
