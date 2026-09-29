#!/usr/bin/env bash
set -euo pipefail
: "${EZIL_VALIDATE_IMAGE:?must test the image built for this source}"
docker image inspect "$EZIL_VALIDATE_IMAGE" >/dev/null
bun test --reporter=junit --reporter-outfile=container-junit.xml \
  worker/src/browser-sidecar.container.test.ts \
  worker/src/neko-browser-window.container.test.ts \
  worker/scripts/mobile-keyboard.container.test.ts 2>&1 | tee container-test.log
python3 - <<'PY'
import xml.etree.ElementTree as ET
root = ET.parse('container-junit.xml').getroot()
cases = list(root.iter('testcase'))
assert cases, 'No desktop tests executed'
assert not any(c.find(t) is not None for c in cases for t in ('skipped', 'failure', 'error')), 'Desktop failures or skips'
PY
