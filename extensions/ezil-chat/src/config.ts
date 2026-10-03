import * as vscode from 'vscode';
import { parseModelKey, type ModelId } from './opencode/adapter';
import { PINNED_OPENCODE_VERSION } from './opencode/version';

export { PINNED_OPENCODE_VERSION };

export interface Settings {
    opencodePath: string;
    serverUrl: string;
    serverPassword: string;
    configPath: string;
    defaultAgent: string;
    defaultModel: ModelId | undefined;
    autoStart: boolean;
    revealOnStartup: boolean;
}

export function readSettings(): Settings {
    const config = vscode.workspace.getConfiguration('ezilChat');
    const text = (key: string, fallback = ''): string => {
        const value = config.get<string>(key);
        return typeof value === 'string' && value.trim() ? value.trim() : fallback;
    };
    return {
        opencodePath: text('opencodePath', 'opencode'),
        serverUrl: text('serverUrl'),
        serverPassword: text('serverPassword'),
        configPath: text('configPath'),
        defaultAgent: text('defaultAgent', 'build'),
        defaultModel: parseModelKey(text('defaultModel')),
        autoStart: config.get<boolean>('autoStart', true),
        revealOnStartup: config.get<boolean>('revealOnStartup', true),
    };
}
