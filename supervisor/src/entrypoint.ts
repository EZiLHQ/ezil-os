import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Node resolves module URLs through the installed release-directory symlink.
 * Resolve argv the same way so a CLI cannot silently skip its main function.
 * Merely importing a module must never start a host or delivery operation. */
export function isEntrypoint(moduleUrl: string): boolean {
    try { return !!process.argv[1] && moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href; }
    catch { return false; }
}
