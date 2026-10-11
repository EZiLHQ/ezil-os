#!/bin/sh
# npm script-shell (image /usr/local/etc/npmrc). Plain `exec /bin/sh "$@"`,
# except that `npm run <script>` in a project whose dependencies are still being
# restored after a restart first says so and waits (bounded; ezil-deps gate).
# Never for install lifecycle scripts (a user's own npm install), never for the
# restore's own install (EZIL_DEPS_RESTORING), and only for the exact project
# being run (npm_package_json). EZIL_DEPS_WAIT_SECONDS=0 turns the wait off.
if [ -z "${EZIL_DEPS_RESTORING:-}" ] && [ -n "${npm_package_json:-}" ] && [ -x /usr/local/bin/ezil-deps ]; then
  case "${npm_lifecycle_event:-}" in
    ''|preinstall|install|postinstall|prepublish|preprepare|prepare|postprepare|preuninstall|uninstall|postuninstall|dependencies) ;;
    *) /usr/local/bin/ezil-deps gate "$(dirname "$npm_package_json")" ;;
  esac
fi
exec /bin/sh "$@"
