#!/usr/bin/env bash
set -eu
credits_worktree=/dev/shm/ezil-unified-20261026/os-credits
cd "$credits_worktree/app"
export TMPDIR="$credits_worktree/.task-tmp"
exec env -u BILLING_TEST_DATABASE_URL -u DATABASE_URL NODE_DISABLE_COMPILE_CACHE=1 \
    node node_modules/vitest/vitest.mjs run \
    --config ../.task-tmp/vitest.config.mjs --configLoader runner --no-cache \
    src/server/billing/ai-credits.test.ts \
    src/server/billing/ai-credit-outbox.test.ts \
    src/server/billing/ai-credit-outbox.pg.test.ts \
    src/server/billing/ai-gateway-client.test.ts \
    src/server/billing/processor.test.ts \
    src/server/billing/store.test.ts \
    src/server/billing/http/stripe-webhook.test.ts \
    src/server/billing/__contract__/catalog.contract.test.ts
