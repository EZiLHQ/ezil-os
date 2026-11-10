// The one fake `vscode` module for every test file: bun shares its module registry across files,
// so whichever file loads src/ first fixes the vscode binding for all of them.

export class TextPart { constructor(public value: string) {} }
export class ToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
export class ToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
export class DataPart { constructor(public data: Uint8Array, public mimeType: string) {} static text(value: string, mime = 'text/plain') { return new DataPart(new TextEncoder().encode(value), mime); } }
export class ThinkingPart { constructor(public value: string | string[], public id?: string, public metadata?: Record<string, unknown>) {} }
export class ChatMessage {
    constructor(public role: number, public content: unknown[], public name?: string) {}
    static User(value: string) { return new ChatMessage(1, [new TextPart(value)]); }
    static Assistant(value: string) { return new ChatMessage(2, [new TextPart(value)]); }
}
export class ChatRequestTurn { constructor(public prompt: string, public participant: string) {} }
export class ChatResponseMarkdownPart { value: { value: string }; constructor(value: string) { this.value = { value }; } }
export class ChatResponseTurn { constructor(public response: unknown[], public participant: string) {} }
export class ThemeIcon { constructor(public id: string) {} }
export class EventEmitter<T> { private listeners: ((value: T) => void)[] = []; event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose: () => {} }; }; fire(value: T) { for (const listener of this.listeners) listener(value); } dispose() {} }

export const fakeVscode: Record<string, unknown> = {
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelDataPart: DataPart,
    LanguageModelThinkingPart: ThinkingPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    LanguageModelChatMessage: ChatMessage,
    ChatRequestTurn,
    ChatResponseTurn,
    ChatResponseMarkdownPart,
    chat: { createChatParticipant: (id: string, handler: unknown) => ({ id, handler, dispose() {} }) },
    EventEmitter,
    ThemeIcon,
    StatusBarAlignment: { Right: 2 },
    workspace: { getConfiguration: () => ({ get: () => undefined }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    lm: { registerLanguageModelChatProvider: () => ({ dispose() {} }) },
    // Owned here and mutated in place by tests: bun's mock.module snapshots top-level
    // properties, so a test that REPLACED `window` would not reach a module imported
    // under another file's earlier mock.
    window: { showErrorMessage: async () => undefined, showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
    env: { openExternal: async () => true },
    Uri: { parse: (value: string) => new URL(value) },
    commands: { executeCommand: async () => undefined },
};
