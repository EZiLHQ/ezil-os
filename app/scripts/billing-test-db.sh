#!/usr/bin/env bash
# Disposable, isolated Postgres for the billing DB suites (store, processor,
# stripe-live). Never touches a shared or production database.
#
#   app/scripts/billing-test-db.sh up     # start + migrate; prints the URL
#   app/scripts/billing-test-db.sh url    # print BILLING_TEST_DATABASE_URL
#   app/scripts/billing-test-db.sh down   # remove the container
#
#   eval "$(app/scripts/billing-test-db.sh up)"   # exports BILLING_TEST_DATABASE_URL
#
# Uses the Supabase Postgres image because 0003+ need `auth.users` and
# `auth.role()`. Publishes on 127.0.0.1 only and bind-mounts nothing, so the
# host's dev-port reconciler has nothing to tunnel. Migrations are fed over
# stdin in journal order (app/drizzle/meta/_journal.json).
set -euo pipefail

IMAGE="${BILLING_TEST_DB_IMAGE:-public.ecr.aws/supabase/postgres:17.6.1.140}"
NAME="${BILLING_TEST_DB_NAME:-ezil-billing-v2-testdb}"
PORT="${BILLING_TEST_DB_PORT:-55432}"
PASSWORD="billing-test-only"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="postgres://postgres:${PASSWORD}@127.0.0.1:${PORT}/postgres"

psql_in() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres "$@"; }

case "${1:-}" in
  up)
    if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "billing-test-db: container $NAME already exists; run 'down' first" >&2
      exit 1
    fi
    docker run -d --name "$NAME" --label ezil.purpose=billing-test-db \
      -e POSTGRES_PASSWORD="$PASSWORD" -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
    for _ in $(seq 1 90); do
      if docker exec "$NAME" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 \
        && psql_in -tAc "select 1 from pg_namespace where nspname = 'auth'" 2>/dev/null | grep -q 1; then
        break
      fi
      sleep 1
    done
    psql_in -tAc "select to_regclass('auth.users') is not null and to_regprocedure('auth.role()') is not null" | grep -qx t \
      || { echo "billing-test-db: image lacks auth.users / auth.role()" >&2; exit 1; }
    # The app schema references Supabase's auth users; drizzle's journal fixes the order.
    for tag in $(node -e "for (const e of require('$APP_DIR/drizzle/meta/_journal.json').entries) console.log(e.tag)"); do
      psql_in < "$APP_DIR/drizzle/$tag.sql" >/dev/null
      echo "billing-test-db: applied $tag" >&2
    done
    echo "export BILLING_TEST_DATABASE_URL='$URL'"
    ;;
  url)
    echo "$URL"
    ;;
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "billing-test-db: removed $NAME" >&2
    ;;
  *)
    echo "usage: $0 up|url|down" >&2
    exit 2
    ;;
esac
