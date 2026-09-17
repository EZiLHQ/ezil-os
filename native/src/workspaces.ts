import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeError, UUID, workspaceId, type EditorState } from './contract.ts';

export interface WorkspaceRecord {
    schemaVersion: 1; owner: 'ezil-native' | 'electron'; guestId: string; id: string;
    name: string; createdAt: string; editorState: EditorState;
}
interface Index { schemaVersion: 1; owner: 'ezil-native'; guestId: string; selectedId: string | null }
export interface AttachedWorkspace { id: string; root: string }
function safePath(path: string): void {
    const parts = resolve(path).slice(parse(path).root.length).split('/');
    let cursor = parse(path).root;
    for (const part of parts) {
        cursor = join(cursor, part);
        try { if (lstatSync(cursor).isSymbolicLink()) throw new NativeError('symlink_refused', 409); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    }
}
function read(path: string): unknown {
    safePath(path);
    const st = lstatSync(path);
    if (!st.isFile() || st.size > 16_384) throw new NativeError('invalid_record', 409);
    return JSON.parse(readFileSync(path, 'utf8'));
}
function write(path: string, value: unknown): void {
    safePath(path);
    const temp = join(dirname(path), `.write-${randomUUID()}`);
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
}
function checkTree(path: string): void {
    safePath(path);
    const st = lstatSync(path);
    if (st.isDirectory()) for (const child of readdirSync(path)) checkTree(join(path, child));
    else if (!st.isFile() || st.nlink !== 1) throw new NativeError('unsafe_file', 409);
}
/** One helper owns an explicit root. Stale locks require an operator to verify exit. */
export function acquireDataRoot(dataRoot: string): () => void {
    if (!isAbsolute(dataRoot) || resolve(dataRoot) === '/') throw new NativeError('explicit_data_root_required');
    const root = join(resolve(dataRoot), 'native-v1');
    safePath(root);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const lock = join(root, 'helper.lock');
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch { throw new NativeError('data_root_in_use', 409); }
    return () => { safePath(lock); rmSync(lock, { recursive: true }); };
}
export class WorkspaceStore {
    readonly root: string;
    private index: Index;
    private attached?: { record: WorkspaceRecord; files: string; profile: string };
    constructor(dataRoot: string, attached?: AttachedWorkspace) {
        if (!isAbsolute(dataRoot) || resolve(dataRoot) === '/') throw new NativeError('explicit_data_root_required');
        if (attached) {
            workspaceId(attached.id);
            if (!isAbsolute(attached.root)) throw new NativeError('invalid_workspace_root');
            safePath(attached.root);
            if (!lstatSync(attached.root).isDirectory()) throw new NativeError('invalid_workspace_root');
        }
        safePath(dataRoot);
        this.root = join(resolve(dataRoot), 'native-v1');
        safePath(this.root);
        mkdirSync(this.root, { recursive: true, mode: 0o700 });
        const file = join(this.root, 'index.json');
        try { this.index = read(file) as Index; }
        catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            this.index = { schemaVersion: 1, owner: 'ezil-native', guestId: randomUUID(), selectedId: null };
            write(file, this.index);
        }
        if (this.index?.schemaVersion !== 1 || this.index.owner !== 'ezil-native' || !UUID.test(this.index.guestId)
            || (this.index.selectedId !== null && !UUID.test(this.index.selectedId))) throw new NativeError('invalid_index', 409);
        if (attached) {
            // Only profiles belong to the helper. The inherited project is never
            // recorded as a helper-owned tree and cannot enter its removal path.
            const profile = join(this.root, 'attached', attached.id, 'profile');
            safePath(profile);
            for (const directory of [profile, join(profile, 'code'), join(profile, 'browser')]) {
                safePath(directory);
                mkdirSync(directory, { recursive: true, mode: 0o700 });
            }
            this.attached = { files: resolve(attached.root), profile, record: {
                schemaVersion: 1, owner: 'electron', guestId: this.guestId,
                id: attached.id, name: 'Workspace', createdAt: new Date().toISOString(), editorState: 'unknown',
            } };
            return;
        }
        safePath(join(this.root, 'workspaces'));
        mkdirSync(join(this.root, 'workspaces'), { recursive: true, mode: 0o700 });
        // Restart cannot prove an external editor exited. Preserve that uncertainty.
        for (const record of this.list()) if (record.editorState === 'active') this.setEditor(record.id, 'unknown');
    }
    get guestId(): string { return this.index.guestId; }
    get selectedId(): string | null { return this.attached?.record.id ?? this.index.selectedId; }
    paths(id: string): { files: string; profile: string } {
        if (this.attached) {
            if (workspaceId(id) !== this.attached.record.id) throw new NativeError('workspace_not_found', 404);
            return { files: this.attached.files, profile: this.attached.profile };
        }
        const base = join(this.root, 'workspaces', workspaceId(id));
        return { files: join(base, 'files'), profile: join(base, 'profile') };
    }
    get(id: string): WorkspaceRecord {
        if (this.attached) {
            for (const path of Object.values(this.paths(id))) {
                safePath(path);
                if (!lstatSync(path).isDirectory()) throw new NativeError('unsafe_workspace', 409);
            }
            return { ...this.attached.record };
        }
        const file = join(this.root, 'workspaces', workspaceId(id), 'workspace.json');
        let record: WorkspaceRecord;
        try { record = read(file) as WorkspaceRecord; }
        catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new NativeError('workspace_not_found', 404); throw err; }
        if (record?.schemaVersion !== 1 || record.owner !== 'ezil-native' || record.guestId !== this.guestId || record.id !== id
            || typeof record.name !== 'string' || record.name.length > 80 || typeof record.createdAt !== 'string'
            || !['active', 'closed', 'unknown'].includes(record.editorState)) throw new NativeError('ownership_refused', 409);
        for (const path of Object.values(this.paths(id))) {
            safePath(path);
            if (!lstatSync(path).isDirectory()) throw new NativeError('unsafe_workspace', 409);
        }
        return record;
    }
    list(): WorkspaceRecord[] {
        if (this.attached) return [this.get(this.attached.record.id)];
        safePath(join(this.root, 'workspaces'));
        return readdirSync(join(this.root, 'workspaces')).filter(id => UUID.test(id)).map(id => this.get(id));
    }
    create(name: string): WorkspaceRecord {
        if (this.attached) throw new NativeError('electron_owned_workspace', 409);
        if (this.list().length >= 100) throw new NativeError('workspace_limit', 409);
        const id = randomUUID();
        const base = join(this.root, 'workspaces', id);
        safePath(base);
        mkdirSync(base, { mode: 0o700 });
        for (const path of Object.values(this.paths(id))) mkdirSync(path, { mode: 0o700 });
        const record: WorkspaceRecord = { schemaVersion: 1, owner: 'ezil-native', guestId: this.guestId, id, name: name.trim(), createdAt: new Date().toISOString(), editorState: 'closed' };
        write(join(base, 'workspace.json'), record);
        if (!this.selectedId) this.select(id);
        return record;
    }
    select(id: string): WorkspaceRecord {
        const record = this.get(id);
        if (this.attached) return record;
        this.index.selectedId = id;
        write(join(this.root, 'index.json'), this.index);
        return record;
    }
    setEditor(id: string, state: EditorState): WorkspaceRecord {
        const record = { ...this.get(id), editorState: state };
        if (this.attached) { this.attached.record = record; return record; }
        write(join(this.root, 'workspaces', id, 'workspace.json'), record);
        return record;
    }
    remove(id: string): void {
        if (this.attached) throw new NativeError('electron_owned_workspace', 409);
        const record = this.get(id);
        if (record.editorState !== 'closed') throw new NativeError('editor_not_closed', 409);
        const base = join(this.root, 'workspaces', id);
        checkTree(base);
        // Only this owned schema tree is removed. Legacy VM directories are untouched.
        rmSync(base, { recursive: true });
        if (this.selectedId === id) {
            this.index.selectedId = null;
            write(join(this.root, 'index.json'), this.index);
        }
    }
}
