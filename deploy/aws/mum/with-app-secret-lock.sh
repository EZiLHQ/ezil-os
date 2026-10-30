#!/usr/bin/env bash
# All read/modify/write steps of the command must run inside this lock.
# Usage: with-app-secret-lock.sh [--namespace mum|prd] <cmd> [args...] (default mum).
set -euo pipefail
set +x
umask 077
namespace=mum
if [[ "${1:-}" == --namespace ]]; then (($# >= 3)) || { printf 'ERROR: missing namespace or command\n' >&2; exit 1; }; namespace=$2; shift 2; fi
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/json-tool.py" --namespace "$namespace" with-app-secret-lock "$@"
