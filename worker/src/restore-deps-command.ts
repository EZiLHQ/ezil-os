/**
 * Background dependency restore for a freshly hydrated container: the same
 * boot-restore marker and log as start-neko.sh, so `ezil-deps` reports
 * "checking projects" at once. The path is validated, never interpolated raw.
 */
export function restoreDepsCommand(mountPath: string): string {
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(mountPath) || mountPath.includes('..')) throw new Error('invalid workspace path');
  return `bash -c 'mkdir -p /run/ezil-deps && rm -f /run/ezil-deps/scanned && : > /run/ezil-deps/boot-restore; `
    + `exec /usr/local/bin/ezil-restore-deps.sh --boot ${mountPath} >> /tmp/ezil-restore-deps.log 2>&1'`;
}
