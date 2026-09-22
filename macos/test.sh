#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
for script in "$here/build-dmg.sh" "$here/e2e.sh" "$here/runtime/build-runtime.sh" "$here/runtime/make-fixture.sh" "$here/runtime/ezil-init"; do
  bash -n "$script"
done
if [ "$(uname -s)" = Darwin ]; then
  (cd "$here" && swift test --parallel)
else
  echo "Legacy script syntax passed; Swift migration compatibility tests require macOS."
fi
