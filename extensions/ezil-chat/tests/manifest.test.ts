// Guards the contract between package.json, the pinned OpenCode version and the webview HTML.
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINNED_OPENCODE_VERSION } from '../src/opencode/version';
import { parseModelKey } from '../src/opencode/adapter';

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>; engines: { vscode: string }; enabledApiProposals?: unknown; activationEvents: string[];
    contributes: { viewsContainers: { secondarySidebar: Array<{ id: string }> }; views: Record<string, Array<{ id: string; type: string }>>; configurationDefaults: Record<string, unknown>; commands: Array<{ command: string }>; configuration: { properties: Record<string, unknown> } };
};

test('pins @opencode/client to the exact version the extension expects from opencode serve', () => {
    expect(manifest.dependencies['@opencode/client']).toBe(PINNED_OPENCODE_VERSION);
    expect(PINNED_OPENCODE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test('uses only stable VS Code APIs and the secondary sidebar container', () => {
    expect(manifest.engines.vscode).toBe('^1.106.0');
    expect(manifest.enabledApiProposals).toBeUndefined();
    expect(manifest.activationEvents).toEqual(['onStartupFinished', 'onView:ezil-chat.panel']);
    expect(manifest.contributes.viewsContainers.secondarySidebar.map(container => container.id)).toEqual(['ezil-chat']);
    expect(manifest.contributes.views['ezil-chat']).toEqual([expect.objectContaining({ id: 'ezil-chat.panel', type: 'webview' })]);
    expect(manifest.contributes.configurationDefaults).toEqual({ 'chat.disableAIFeatures': true, 'workbench.secondarySideBar.defaultVisibility': 'visible' });
    expect(manifest.contributes.commands.map(command => command.command).sort()).toEqual(['ezil-chat.addSelectionToChat', 'ezil-chat.newSession', 'ezil-chat.open', 'ezil-chat.pickModel', 'ezil-chat.restartServer']);
    for (const key of ['ezilChat.opencodePath', 'ezilChat.serverUrl', 'ezilChat.defaultAgent', 'ezilChat.defaultModel', 'ezilChat.autoStart', 'ezilChat.configPath']) expect(manifest.contributes.configuration.properties[key]).toBeDefined();
});

test('defaultModel setting parses provider/model#variant', () => {
    expect(parseModelKey('azure/claude-sonnet-4-5')).toEqual({ providerID: 'azure', modelID: 'claude-sonnet-4-5' });
    expect(parseModelKey('azure/gpt-5#high')).toEqual({ providerID: 'azure', modelID: 'gpt-5', variant: 'high' });
    expect(parseModelKey('nonsense')).toBeUndefined();
    expect(parseModelKey('azure/')).toBeUndefined();
});
