// ConfigStore: file loading, last-good retention across invalid rewrites, directory watching (with a fake `vscode`).

import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

mock.module('vscode', () => ({}));
const { ConfigStore, resolveConfigPath, settingsSnippet } = await import('../src/extension');
const { parseModelsConfig } = await import('../src/config');

const VALID = JSON.stringify({ providers: { p: { type: 'openai', apiKey: 'sk-abc-12345' } }, models: [{ id: 'm', provider: 'p', model: 'gpt-5.5', roles: ['default', 'utility'] }] });
const VALID_TWO = JSON.stringify({ providers: { p: { type: 'openai', apiKey: 'sk-abc-12345' } }, models: [{ id: 'm', provider: 'p', model: 'gpt-5.5' }, { id: 'n', provider: 'p', model: 'gpt-5.5-mini' }] });
const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'ezil-models-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

async function until(predicate: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) { if (predicate()) return true; await Bun.sleep(50); }
    return predicate();
}

describe('ConfigStore', () => {
    test('keeps the last good config while the file is invalid or missing, and reports the error', () => {
        const file = path.join(root, 'a', 'models.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const logs: string[] = [];
        const store = new ConfigStore(file, line => logs.push(line));
        let changes = 0;
        store.onChange(() => { changes += 1; });
        expect(store.load()).toBe(false);
        expect(store.error()).toContain('does not exist');
        expect(store.models()).toEqual([]);
        fs.writeFileSync(file, VALID);
        expect(store.load()).toBe(true);
        expect(store.models().map(model => model.id)).toEqual(['m']);
        expect(store.secrets()).toEqual(['sk-abc-12345']);
        fs.writeFileSync(file, '{ "providers": { "p": { "type": "openai", "apiKey": "sk-abc-1234'); // half-written
        expect(store.load()).toBe(false);
        expect(store.error()).toContain('not valid JSON');
        expect(store.models().map(model => model.id)).toEqual(['m']); // still served
        expect(logs.at(-1)).toContain('keeping the 1 model(s) loaded before');
        fs.rmSync(file);
        expect(store.load()).toBe(false);
        expect(store.models()).toHaveLength(1);
        fs.writeFileSync(file, VALID_TWO);
        expect(store.load()).toBe(true);
        expect(store.error()).toBeUndefined();
        expect(store.models().map(model => model.id)).toEqual(['m', 'n']);
        expect(changes).toBe(5); // one notification per load()
        for (const line of logs) expect(line).not.toContain('sk-abc-12345');
        store.dispose();
    });

    // A fake fs.watch: records watched directories, lets the test fire events and counts closes. bun's own
    // inotify wrapper drops events after a rename in the same process, so the real one is not used here; the
    // real semantics (an atomic replace shows up as `rename <tmp>` + `rename <name>`, a write as `change`)
    // were checked under Node, which is what the extension host runs.
    function fakeWatch() {
        const watched: string[] = [];
        let callback: ((event: string, filename: string | null) => void) | undefined;
        let closed = 0;
        const watchFs = ((directory: string, _options: unknown, listener: (event: string, filename: string | null) => void) => {
            if (!fs.existsSync(directory)) { const error = new Error(`ENOENT: no such file or directory, watch '${directory}'`) as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
            watched.push(directory);
            callback = listener;
            return { close: () => { closed += 1; callback = undefined; }, on: () => undefined } as unknown as fs.FSWatcher;
        }) as unknown as typeof fs.watch;
        return { watchFs, watched, fire: (event: string, filename: string | null) => callback?.(event, filename), get closed() { return closed; }, get active() { return callback !== undefined; } };
    }

    test('any event in the directory reloads once after the debounce, only when the bytes changed', async () => {
        const dir = path.join(root, 'b');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'models.json');
        fs.writeFileSync(file, VALID);
        const watch = fakeWatch();
        const store = new ConfigStore(file, () => undefined, watch.watchFs);
        let changes = 0;
        store.onChange(() => { changes += 1; });
        store.watch();
        store.load();
        expect(watch.watched).toEqual([dir]);
        expect(store.models()).toHaveLength(1);
        expect(changes).toBe(1);
        // A plain rewrite: `change models.json`. Three quick events collapse into one reload.
        fs.writeFileSync(file, VALID_TWO);
        watch.fire('change', 'models.json'); watch.fire('change', 'models.json'); watch.fire('change', 'models.json');
        expect(store.models()).toHaveLength(1); // not before the debounce
        expect(await until(() => store.models().length === 2)).toBe(true);
        expect(changes).toBe(2);
        // An atomic replace may only surface as an event for the temp name.
        fs.writeFileSync(`${file}.tmp`, VALID);
        fs.renameSync(`${file}.tmp`, file);
        watch.fire('rename', 'models.json.tmp');
        expect(await until(() => store.models().length === 1)).toBe(true);
        expect(changes).toBe(3);
        // Unrelated churn (an editor swap file) with unchanged config bytes: no re-parse, no notification.
        watch.fire('change', '.models.json.swp');
        await Bun.sleep(500);
        expect(changes).toBe(3);
        // A half-written file keeps the last good models and is retried on the next event.
        fs.writeFileSync(file, '{"providers": {');
        watch.fire('change', 'models.json');
        expect(await until(() => store.error() !== undefined)).toBe(true);
        expect(store.models()).toHaveLength(1);
        fs.writeFileSync(file, VALID_TWO);
        watch.fire('change', 'models.json');
        expect(await until(() => store.models().length === 2)).toBe(true);
        expect(store.error()).toBeUndefined();
        // Switching paths closes the old watcher and starts clean; disposing closes the new one.
        const other = path.join(root, 'c', 'models.json');
        store.setPath(other);
        expect(watch.closed).toBe(1);
        expect(store.path).toBe(other);
        expect(store.models()).toEqual([]);
        expect(store.error()).toContain('does not exist');
        expect(watch.active).toBe(false); // the directory does not exist yet
        fs.mkdirSync(path.dirname(other), { recursive: true });
        fs.writeFileSync(other, VALID_TWO);
        expect(store.load()).toBe(true); // the first successful load arms the watcher for a directory created later
        expect(watch.watched).toEqual([dir, path.dirname(other)]);
        expect(watch.active).toBe(true);
        store.dispose();
        expect(watch.closed).toBe(2);
    });

    test('the real fs.watch is used by default and delivers a rewrite', async () => {
        const dir = path.join(root, 'real');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'models.json');
        fs.writeFileSync(file, VALID);
        const store = new ConfigStore(file, () => undefined);
        store.watch();
        store.load();
        expect(store.models().length).toBe(1);
        // Bun arms an inotify watcher asynchronously, so a write that lands before it is armed produces no event.
        // Rewriting the same new bytes every 500 ms (longer than the store's 250 ms debounce) until the reload
        // shows up keeps the test deterministic without weakening it: the test never calls load() after the
        // rewrite, so a second model can only appear through the watcher's own `load(true)`.
        const deadline = Date.now() + 5000;
        let nextWrite = 0;
        while (Date.now() < deadline && store.models().length !== 2) {
            if (Date.now() >= nextWrite) { fs.writeFileSync(file, VALID_TWO); nextWrite = Date.now() + 500; }
            await Bun.sleep(50);
        }
        expect(store.models().map(model => model.id)).toEqual(['m', 'n']);
        store.dispose();
    });

    test('a provider whose variable is not set is skipped with a warning; the file still loads and the other models are served', () => {
        const file = path.join(root, 'partial', 'models.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
            providers: { p: { type: 'openai', apiKey: 'sk-abc-12345' }, q: { type: 'anthropic', apiKey: '{env:EZIL_TEST_UNSET_KEY}' } },
            models: [{ id: 'm', provider: 'p', model: 'gpt-5.5' }, { id: 'c', provider: 'q', model: 'claude-sonnet-5' }, { id: 'bad', provider: 'p', model: 'x', roles: ['boss'] }],
        }));
        const logs: string[] = [];
        const store = new ConfigStore(file, line => logs.push(line));
        expect(store.load()).toBe(true); // not an error: the file is usable
        expect(store.error()).toBeUndefined();
        expect(store.models().map(model => model.id)).toEqual(['m']);
        expect(store.problems()).toEqual([
            'providers.q skipped (1 model(s) not served): apiKey: environment variable EZIL_TEST_UNSET_KEY is not set',
            'models[2].roles must be an array of default, plan, utility, utilitySmall',
        ]);
        const loaded = logs.at(-1)!;
        expect(loaded).toContain('1 model(s), 2 entries not served');
        expect(loaded).toContain('warning: providers.q skipped');
        expect(loaded).toContain('EZIL_TEST_UNSET_KEY');
        expect(loaded).not.toContain('sk-abc-12345');
        store.dispose();
    });
});

test('resolveConfigPath: env wins over the setting, the setting over the default', () => {
    expect(resolveConfigPath('/x/models.json', {})).toBe('/x/models.json');
    expect(resolveConfigPath('  ', {})).toBe('/etc/ezil/models.json');
    expect(resolveConfigPath('/x/models.json', { EZIL_MODELS_CONFIG: '/env/models.json' })).toBe('/env/models.json');
});

test('settingsSnippet maps roles to the Copilot Chat settings', () => {
    const config = parseModelsConfig(VALID);
    expect(settingsSnippet(config.models)).toEqual({ 'chat.allowAnonymousAccess': true, 'chat.byokUtilityModelDefault': 'mainAgent', 'chat.defaultModel': 'm', 'chat.utilityModel': 'ezil/m' });
});
