import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ConfigError, describeConfig, isGateway, parseModelsConfig, type ResolvedConfig, type ResolvedModel } from './config';
import { readCredits } from './gateway';
import { EZiLModelsProvider } from './provider';
import type { Usage } from './types';

export const DEFAULT_CONFIG_PATH = '/etc/ezil/models.json';
export const CONFIG_ENV = 'EZIL_MODELS_CONFIG';

export function resolveConfigPath(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env[CONFIG_ENV]?.trim();
    if (fromEnv) return fromEnv;
    const fromSetting = setting?.trim();
    return fromSetting ? fromSetting : DEFAULT_CONFIG_PATH;
}

/**
 * Loads the config file, watches it (atomic replaces included) and keeps the last good result: a half-written
 * or invalid file leaves the previously loaded models in place (with `error()` set) so in-flight and new chats
 * keep working while the file is being edited.
 */
export class ConfigStore implements vscode.Disposable {
    private current: ResolvedConfig | undefined;
    private lastText: string | undefined;
    private lastError: string | undefined;
    private watcher: fs.FSWatcher | undefined;
    private debounce: NodeJS.Timeout | undefined;
    private readonly listeners = new Set<() => void>();

    /** `watchFs` is injectable so the reload logic can be tested without depending on the runtime's inotify behaviour. */
    constructor(private configPath: string, private readonly log: (line: string) => void, private readonly watchFs: typeof fs.watch = fs.watch) {}

    get path(): string { return this.configPath; }
    models(): ResolvedModel[] { return this.current?.models ?? []; }
    secrets(): string[] { return this.current?.secrets ?? []; }
    /** Why the file as a whole could not be loaded (unreadable, not JSON, no providers/models). */
    error(): string | undefined { return this.lastError; }
    /** Entries of the loaded file that are not served: providers whose secret is not set (warnings) and invalid entries (errors). */
    problems(): string[] { return this.current ? [...this.current.warnings, ...this.current.errors] : []; }
    onChange(listener: () => void): vscode.Disposable { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }

    setPath(configPath: string): void {
        if (configPath === this.configPath) return;
        this.configPath = configPath;
        this.current = undefined; // a different file: nothing loaded from it yet
        this.lastText = undefined;
        this.watch();
        this.load();
    }

    /** (Re)loads the file. `ifChanged` skips the parse and the change notification when the bytes are as before. */
    load(ifChanged = false): boolean {
        try {
            const text = fs.readFileSync(this.configPath, 'utf8');
            if (ifChanged && text === this.lastText) return !this.lastError;
            this.lastText = text;
            this.current = parseModelsConfig(text, { source: this.configPath });
            this.lastError = undefined;
            this.log(`[config] loaded ${this.configPath}: ${this.current.models.length} model(s)${this.problems().length ? `, ${this.problems().length} entr${this.problems().length === 1 ? 'y' : 'ies'} not served (see below)` : ''}\n${describeConfig(this.current)}`);
            if (!this.watcher) this.watch(); // the directory may not have existed when watching was first attempted
        } catch (error) {
            if (!(error instanceof ConfigError)) this.lastText = undefined;
            this.lastError = error instanceof ConfigError ? error.message : (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${this.configPath} does not exist.` : `${this.configPath}: ${(error as Error).message}`;
            this.log(`[config] ${this.lastError}${this.current ? ` (keeping the ${this.current.models.length} model(s) loaded before)` : ''}`);
        }
        for (const listener of this.listeners) listener();
        return !this.lastError;
    }

    watch(): void {
        this.watcher?.close();
        this.watcher = undefined;
        const directory = path.dirname(this.configPath);
        try {
            // Watch the directory rather than the file so editors that replace the file (write a temp name, then
            // rename over it) still trigger. Such a replace may surface only as an event for the temp name (Bun
            // reports just `rename models.json.tmp`), so every event in the directory schedules a debounced
            // reload; `load(true)` then does nothing unless the file's bytes actually changed.
            this.watcher = this.watchFs(directory, { persistent: false }, () => {
                clearTimeout(this.debounce);
                this.debounce = setTimeout(() => this.load(true), 250);
            });
            this.watcher.on('error', error => this.log(`[config] watcher error: ${error.message}`));
        } catch (error) {
            this.log(`[config] cannot watch ${directory}: ${(error as Error).message}`);
        }
    }

    dispose(): void {
        clearTimeout(this.debounce);
        this.watcher?.close();
        this.listeners.clear();
    }
}

export type UsageRecord = Usage & { requests: number; elapsedMs: number };

export class UsageTracker {
    readonly perModel = new Map<string, UsageRecord>();
    record(model: ResolvedModel, usage: Usage, elapsedMs: number): UsageRecord {
        const record = this.perModel.get(model.id) ?? { requests: 0, elapsedMs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        record.requests += 1; record.elapsedMs += elapsedMs;
        record.inputTokens += usage.inputTokens; record.outputTokens += usage.outputTokens;
        record.cacheReadTokens += usage.cacheReadTokens; record.cacheWriteTokens += usage.cacheWriteTokens;
        this.perModel.set(model.id, record);
        return record;
    }
    report(): string {
        if (!this.perModel.size) return 'No requests yet.';
        const lines = ['model            requests   input   output  cache_read  cache_write   avg_ms'];
        for (const [id, record] of this.perModel) {
            lines.push(`${id.padEnd(16)} ${String(record.requests).padStart(8)} ${String(record.inputTokens).padStart(7)} ${String(record.outputTokens).padStart(8)} ${String(record.cacheReadTokens).padStart(11)} ${String(record.cacheWriteTokens).padStart(12)} ${String(Math.round(record.elapsedMs / record.requests)).padStart(8)}`);
        }
        return lines.join('\n');
    }
}

export const CONFIG_TEMPLATE = {
    providers: {
        anthropic: { type: 'anthropic', apiKey: '{env:ANTHROPIC_API_KEY}' },
    },
    models: [
        { id: 'opus-5.5', name: 'Claude Opus 5.5', provider: 'anthropic', model: 'claude-opus-5-5', maxInputTokens: 200000, maxOutputTokens: 64000, thinking: { type: 'adaptive', effort: 'medium' }, cache: { ttl: '5m' }, default: true, roles: ['default', 'plan'] },
        { id: 'haiku-4.5', name: 'Claude Haiku 4.5', provider: 'anthropic', model: 'claude-haiku-4-5', maxInputTokens: 200000, maxOutputTokens: 32000, roles: ['utility', 'utilitySmall'] },
    ],
};

/** The VS Code settings that pin EZiL models into Copilot Chat's default/plan/utility slots. */
export function settingsSnippet(models: readonly ResolvedModel[]): Record<string, unknown> {
    const byRole = (role: ResolvedModel['roles'][number]) => models.find(model => model.roles.includes(role));
    const snippet: Record<string, unknown> = { 'chat.allowAnonymousAccess': true, 'chat.byokUtilityModelDefault': 'mainAgent' };
    const main = byRole('default') ?? models.find(model => model.default);
    if (main) snippet['chat.defaultModel'] = main.id;
    const plan = byRole('plan'); if (plan) snippet['chat.planAgent.defaultModel'] = plan.id;
    const utility = byRole('utility'); if (utility) snippet['chat.utilityModel'] = `ezil/${utility.id}`;
    const small = byRole('utilitySmall'); if (small) snippet['chat.utilitySmallModel'] = `ezil/${small.id}`;
    return snippet;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const output = vscode.window.createOutputChannel('EZiL Models');
    const log = (line: string) => output.appendLine(`${new Date().toISOString()} ${line}`);
    const settings = () => vscode.workspace.getConfiguration('ezilModels');
    const store = new ConfigStore(resolveConfigPath(settings().get<string>('configPath')), log);
    const usage = new UsageTracker();
    const provider = new EZiLModelsProvider({
        models: () => store.models(),
        configError: () => store.error(),
        secrets: () => store.secrets(),
        logRequests: () => settings().get<boolean>('logRequests') === true,
        log,
        recordUsage: (model, used, elapsedMs) => {
            usage.record(model, used, elapsedMs);
            log(`[usage] ${model.id} input=${used.inputTokens} output=${used.outputTokens} cache_read=${used.cacheReadTokens} cache_write=${used.cacheWriteTokens} ${elapsedMs}ms`);
        },
    });
    context.subscriptions.push(output, store, provider);
    context.subscriptions.push(store.onChange(() => provider.refresh()));
    store.watch();
    store.load();
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('ezil', provider));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('ezilModels.configPath')) store.setPath(resolveConfigPath(settings().get<string>('configPath')));
    }));

    const openConfig = async () => {
        if (!fs.existsSync(store.path)) {
            const create = await vscode.window.showWarningMessage(`EZiL Models: ${store.path} does not exist.`, 'Create from template', 'Show output');
            if (create === 'Show output') { output.show(); return; }
            if (create !== 'Create from template') return;
            try {
                fs.mkdirSync(path.dirname(store.path), { recursive: true });
                fs.writeFileSync(store.path, `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
            } catch (error) {
                void vscode.window.showErrorMessage(`EZiL Models: cannot create ${store.path} (${(error as Error).message}). Set ezilModels.configPath or ${CONFIG_ENV} to a writable location.`);
                return;
            }
        }
        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(store.path));
        await vscode.window.showTextDocument(document);
    };
    const reload = () => {
        const ok = store.load();
        const problems = store.problems().length;
        void (ok
            ? problems
                ? vscode.window.showWarningMessage(`EZiL Models: loaded ${store.models().length} model(s) from ${store.path}; ${problems} entr${problems === 1 ? 'y is' : 'ies are'} not served.`, 'Show output').then(choice => { if (choice) output.show(); })
                : vscode.window.showInformationMessage(`EZiL Models: loaded ${store.models().length} model(s) from ${store.path}.`)
            : vscode.window.showErrorMessage(`EZiL Models: ${store.error()}`, 'Show output').then(choice => { if (choice) output.show(); }));
    };
    const showUsage = () => { log(`[usage report]\n${usage.report()}`); output.show(); };
    // EZiL AI credit state (contract §7) for the default gateway model; read fresh each time it is asked for.
    const gatewayModel = () => store.models().find(model => isGateway(model.provider.type) && model.default) ?? store.models().find(model => isGateway(model.provider.type));
    const showCredits = async () => {
        const model = gatewayModel();
        if (!model) { void vscode.window.showInformationMessage('EZiL Models: no EZiL AI model is configured.'); return; }
        const credits = await readCredits(model.provider, model.model);
        log(`[credits] ${model.model}: state=${credits.state}${credits.balance ? ` available_micro=${credits.balance.available_micro} held_micro=${credits.balance.held_micro}` : ''}${credits.models ? ` killswitch=${credits.models.killswitch} pause=${credits.models.pause ?? 'none'}` : ''}`);
        void vscode.window.showInformationMessage(`EZiL AI: ${credits.text}`);
    };
    const manage = async () => {
        type Item = vscode.QuickPickItem & { action?: () => void | Promise<void> };
        const items: Item[] = [
            { label: '$(go-to-file) Open config file', description: store.path, action: openConfig },
            { label: '$(refresh) Reload config', description: store.error() ? 'last load failed' : `${store.models().length} model(s)`, action: reload },
            { label: '$(graph) Show token usage', action: showUsage },
            ...(gatewayModel() ? [{ label: '$(credit-card) Show AI credits', description: 'EZiL AI balance and pause state', action: showCredits }] : []),
            { label: '$(clippy) Copy settings snippet', description: 'chat.defaultModel / plan / utility for the configured roles', action: async () => { await vscode.env.clipboard.writeText(JSON.stringify(settingsSnippet(store.models()), null, 2)); void vscode.window.showInformationMessage('EZiL Models: settings snippet copied to the clipboard.'); } },
        ];
        if (store.error()) items.push({ label: '$(error) Config error', detail: store.error(), action: () => output.show() });
        for (const problem of store.problems()) items.push({ label: `$(warning) ${problem.startsWith('providers.') && problem.includes(' skipped ') ? 'Provider skipped' : 'Invalid entry'}`, detail: problem, action: () => output.show() });
        if (store.models().length) items.push({ label: 'Models', kind: vscode.QuickPickItemKind.Separator });
        for (const model of store.models()) {
            items.push({
                label: `${model.default ? '$(star-full) ' : ''}${model.name}`,
                description: `${model.id} -> ${model.providerName}/${model.model}`,
                detail: `${model.provider.type} · in ${model.maxInputTokens} / out ${model.maxOutputTokens}${model.thinking ? ` · thinking ${model.thinking.type}${model.thinking.effort ? `/${model.thinking.effort}` : ''}` : ''}${model.cache.enabled ? ` · cache ${model.cache.ttl}` : ''}${model.roles.length ? ` · roles ${model.roles.join(', ')}` : ''}`,
                action: () => { void vscode.window.showInformationMessage(`EZiL Models: set "chat.defaultModel": "${model.id}" to make ${model.name} the default.`); },
            });
        }
        const picked = await vscode.window.showQuickPick(items, { title: 'EZiL Models', placeHolder: 'Manage the EZiL model provider' });
        await picked?.action?.();
    };
    context.subscriptions.push(
        vscode.commands.registerCommand('ezil-models.manage', manage),
        vscode.commands.registerCommand('ezil-models.reload', reload),
        vscode.commands.registerCommand('ezil-models.showUsage', showUsage),
        vscode.commands.registerCommand('ezil-models.showCredits', showCredits),
        vscode.commands.registerCommand('ezil-models.openConfig', openConfig),
    );
    log(`[activate] config path ${store.path}${process.env[CONFIG_ENV] ? ` (from ${CONFIG_ENV})` : ''}; proposals: languageModelThinkingPart=${'LanguageModelThinkingPart' in vscode} languageModelSystem=${(vscode.LanguageModelChatMessageRole as unknown as Record<string, unknown>).System === 3}`);
}

export function deactivate(): void {}
