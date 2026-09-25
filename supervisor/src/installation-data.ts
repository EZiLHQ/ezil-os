import { constants } from 'node:fs';
import { mkdir, open, type FileHandle } from 'node:fs/promises';

export async function privateDirectory(root: FileHandle, installationId: string, name: string): Promise<FileHandle> {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(installationId)
        || !/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error('private_directory_unavailable');
    let parent = root;
    try {
        const parts = ['Applications', installationId, name];
        for (const [index, part] of parts.entries()) {
            const path = `/proc/self/fd/${parent.fd}/${part}`;
            let created = false;
            try { await mkdir(path, { mode: 0o700 }); created = true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
            if (created) await parent.sync();
            const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            if (parent !== root) await parent.close();
            parent = child;
            const last = index === parts.length - 1;
            if (created && last) await child.chown(1000, 1000);
            if (created) await child.sync();
            const stat = await child.stat();
            if (stat.uid !== (last ? 1000 : 0) || stat.mode & 0o077 || stat.dev !== (await root.stat()).dev) {
                throw new Error('unsafe_private_directory');
            }
        }
        return parent;
    } catch {
        if (parent !== root) await parent.close();
        throw new Error('private_directory_unavailable');
    }
}
