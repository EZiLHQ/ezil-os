#!/usr/bin/env bash
set -euo pipefail
: "${EZIL_VALIDATE_IMAGE:?must test the image built for this source}"
docker image inspect "$EZIL_VALIDATE_IMAGE" >/dev/null

# The persistence suite runs its containers with --network none. Its real Next.js
# and OpenCode cases need inputs fetched here: a warm npm cache, and ~/.opencode
# from the official installer run INSIDE this exact image. The release is pinned
# (keep it equal to OPENCODE_VERSION in e2e/hosted-home-persistence.mjs): the
# installer's latest-version lookup is an unauthenticated GitHub API call.
# A private directory per run: a fixed path under a shared /tmp would let two runs delete
# each other's inputs. Not removed on exit: the image writes ~/.opencode as root, and CI's
# RUNNER_TEMP is per job.
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/ezil-persistence-inputs.XXXXXX")"
mkdir -p "$work/next-warm" "$work/opencode-out"
(
  cd "$work/next-warm"
  printf '{"name":"warm","version":"0.0.0","private":true}' > package.json
  npm install next@16.4.0 react@19 react-dom@19 --cache "$work/next-npm-cache" --no-audit --no-fund
)
opencode_version=1.18.35
docker run --rm -v "$work/opencode-out:/out" --entrypoint bash "$EZIL_VALIDATE_IMAGE" -c "
  set -euo pipefail
  curl -fsSL --retry 3 --retry-delay 5 -o /tmp/opencode-install.sh https://opencode.ai/install
  test -s /tmp/opencode-install.sh
  bash /tmp/opencode-install.sh --version $opencode_version > /dev/null
  test \"\$(/root/.opencode/bin/opencode --version)\" = $opencode_version
  cp -a /root/.opencode /out/"
export EZIL_NEXT_NPM_CACHE="$work/next-npm-cache"
export EZIL_OPENCODE_DIR="$work/opencode-out/.opencode"
export EZIL_REQUIRE_OPENCODE=1
# The persistence suite reads EZIL_CHECKPOINT_IMAGE first: pin it to this digest too, so an
# ambient value can never send it to another image.
export EZIL_CHECKPOINT_IMAGE="$EZIL_VALIDATE_IMAGE"

# Every suite in the required-case inventory, against this exact digest. A skip,
# a missing required case or a contradictory summary fails, like a failure.
EZIL_TEST_JUNIT=container-junit.xml EZIL_TEST_REQUIRED=.github/scripts/container-required-cases.json \
  bash .github/scripts/run-checked-tests.sh container-test.log bun test --reporter=junit --reporter-outfile=container-junit.xml \
  worker/src/browser-sidecar.container.test.ts \
  worker/src/neko-browser-window.container.test.ts \
  worker/scripts/mobile-keyboard.container.test.ts \
  worker/src/workspace-checkpoint.container.test.ts
