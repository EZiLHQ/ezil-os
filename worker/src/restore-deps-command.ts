/**
 * Background dependency restore for a freshly hydrated container: the same
 * boot-restore marker and log as start-neko.sh, so `ezil-deps` reports
 * "checking projects" at once. The path is validated, never interpolated raw.
 *
 * First, as start-neko.sh does, re-append the readiness wiring: the system restore
 * may have put the user's own /etc/bash.bashrc or global npmrc over the image's, and
 * a Guacamole-mode container never runs start-neko.sh. Without it `npm run` would not
 * wait for a project that is still restoring. `install-hooks` is append-only and
 * idempotent and keeps a script-shell the user chose; its failure never stops the restore.
 */
export function restoreDepsCommand(mountPath: string): string {
  if (!/^\/[A-Za-z0-9._\/-]+$/.test(mountPath) || mountPath.includes('..')) throw new Error('invalid workspace path');
  return `bash -c '{ [ -x /usr/local/bin/ezil-deps ] && /usr/local/bin/ezil-deps install-hooks; } >/dev/null 2>&1 || true; `
    + `mkdir -p /run/ezil-deps && rm -f /run/ezil-deps/scanned && : > /run/ezil-deps/boot-restore; `
    + `exec /usr/local/bin/ezil-restore-deps.sh --boot ${mountPath} >> /tmp/ezil-restore-deps.log 2>&1'`;
}
