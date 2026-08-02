// EZiL OS app-preview workspace: Next.js config.
//
// `root: '/'` works around a hard Turbopack requirement, not a style choice.
// start-neko.sh (this repo's sibling script) symlinks this project's
// `node_modules` to a directory OUTSIDE the workspace root — on local
// ephemeral disk (EZIL_LOCAL_STATE_DIR, e.g. /var/ezil-local) rather than the
// R2-backed workspace mount (e.g. /home/neko/project) — because installing
// node_modules directly onto R2-backed storage is pathologically slow (see
// docs/PLATFORM-NOTES.md §2: a 14k-file clone took ~30 minutes, an
// incremental build exceeded 5 hours).
//
// Next.js 16's default `next dev` bundler (Turbopack) sandboxes file
// resolution to a detected project root and, without this option, FATALS the
// instant it needs to resolve any package through that symlink:
//   Error [TurbopackInternalError]: Symlink [project]/node_modules is
//   invalid, it points out of the filesystem root
// (confirmed against node_modules/next/dist/server/config-schema.js's
// `zTurbopackConfig.root` and config.js's turbopack.root handling in this
// exact Next.js version). Because the workspace root and the local-state
// directory only share the filesystem root as a common ancestor, `root` must
// be widened to `/` for the symlink to resolve at all — there is no narrower
// path that covers both. This container is a single-tenant, disposable
// sandbox (not a shared multi-tenant host), so there is no meaningful
// security downside to widening Turbopack's file-access boundary this far.
//
// Without this, restoring the node_modules/local-disk split (i.e. fixing the
// split so it's never accidentally clobbered) makes the app preview WORSE,
// not better: the split symlink alone, with Turbopack still rejecting it,
// fatals on every single boot instead of only some.
//
// @type {import('next').NextConfig}
module.exports = {
  turbopack: {
    root: '/',
  },
};
