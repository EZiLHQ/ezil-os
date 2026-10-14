#!/usr/bin/env bash
# Full I4 chain from clean: cleanup -> units -> guard -> hostile -> enroll/tunnel ->
# rebase -> full boot (real desktop, host swap) -> worker start-neko test -> cleanup.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$HERE/cleanup.sh" > /dev/null 2>&1            # from clean: scratch removed
OUT=/var/tmp/ezil-host-fb25d9f4/results; mkdir -p "$OUT"; chmod 700 /var/tmp/ezil-host-fb25d9f4
rc=0
for t in test-units test-guard test-hostile test-enroll-tunnel test-rebase test-network test-edge test-boot; do
    "$HERE/$t.sh" > "$OUT/$t.out" 2>&1 || rc=1
    grep -- '^----' "$OUT/$t.out" || echo "---- $t: NO SUMMARY (crashed)"
done
( cd "$HERE/../../../worker" && PATH=/root/.bun/bin:$PATH bun test src/neko-persistent-profiles.test.ts ) > "$OUT/worker.out" 2>&1 || rc=1
grep -E '^ *[0-9]+ (pass|fail)' "$OUT/worker.out" | tr '\n' ' '; echo "(worker neko-persistent-profiles)"
"$HERE/cleanup.sh" --keep-scratch    # keeps only $OUT for reading; run cleanup.sh after
exit $rc
