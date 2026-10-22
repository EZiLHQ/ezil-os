#!/usr/bin/env bash
# All read/modify/write steps of the command must run inside this lock.
set -euo pipefail
set +x
umask 077
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/json-tool.py" with-app-secret-lock "$@"
