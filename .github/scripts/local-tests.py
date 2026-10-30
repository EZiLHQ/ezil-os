#!/usr/bin/env python3
"""Run every local test once, isolating Playwright's Bun subprocess/FD lifetime."""
from collections import Counter
import os
from pathlib import Path
import re
import subprocess
import tempfile

SMOKE = "local/tests/local-smoke.container.test.ts"
TEST_NAME = re.compile(r"[._](?:test|spec)\.(?:js|jsx|ts|tsx)$")
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def inventory(root):
    files = []
    for directory, dirs, names in os.walk(root / "local"):
        dirs[:] = [name for name in dirs if name != "node_modules" and not name.startswith(".")]
        files.extend((Path(directory) / name).relative_to(root).as_posix()
                     for name in names if TEST_NAME.search(name))
    return sorted(files)


def validate_partition(files, groups):
    assigned = [path for group in groups for path in group]
    if len(groups) != 2 or not files or any(not group for group in groups) or Counter(assigned) != Counter(files):
        raise ValueError("local test partition omits or duplicates files")
    if Counter(files).most_common(1)[0][1] != 1 or groups[0] != [SMOKE] or SMOKE in groups[1]:
        raise ValueError("Playwright smoke must run exactly once in its own process")


def validate_report(output, expected):
    output = ANSI.sub("", output)
    # Raw Bun emits ::group::; downloaded Actions logs render ##[group].
    observed = re.findall(r"^(?:::group::|##\[group\])?(?:\./)?(local/.+):$", output, re.MULTILINE)
    if Counter(observed) != Counter(expected):
        raise ValueError("Bun reported omitted, duplicate, or unexpected test files")
    passed = re.findall(r"^ +([0-9]+) pass$", output, re.MULTILINE)
    failed = re.findall(r"^ +([0-9]+) fail$", output, re.MULTILINE)
    skipped = re.findall(r"^ +([0-9]+) (?:skip|todo)$", output, re.MULTILINE)
    totals = re.findall(r"^Ran ([0-9]+) tests? across ([0-9]+) files?\. \[.+\]$", output, re.MULTILINE)
    if len(passed) != 1 or int(passed[0]) <= 0 or failed != ["0"] or len(totals) != 1:
        raise ValueError("Bun success summary missing, ambiguous, or reports failures")
    if any(int(count) for count in skipped) or re.search(r"^\((?:skip|todo)\)", output, re.MULTILINE):
        raise ValueError("local tests reported skips/todos; a skip is not a pass")
    if tuple(map(int, totals[0])) != (int(passed[0]), len(expected)):
        raise ValueError("Bun totals do not match the complete passing file partition")


def main():
    root = Path.cwd()
    files = inventory(root)
    groups = [[SMOKE], [path for path in files if path != SMOKE]]
    validate_partition(files, groups)
    logs = Path(tempfile.mkdtemp(prefix="ezil-local-tests-"))
    failed = False
    for name, group in zip(("smoke", "rest"), groups):
        print(f"local/{name}: {len(group)} files, one Bun process; log {logs / (name + '.log')}", flush=True)
        # Explicit ./ paths are file selections, not Bun substring filters.
        # Always run both partitions once, including when the first fails.
        try:
            result = subprocess.run(["bun", "test", *["./" + path for path in group]],
                                    cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, errors="replace")
            (logs / (name + ".log")).write_text(result.stdout)
            print(result.stdout, end="", flush=True)
            if result.returncode != 0:
                raise ValueError(f"Bun exited {result.returncode}")
            validate_report(result.stdout, group)
        except (OSError, ValueError) as error:
            print(f"::error::local/{name}: {error}", flush=True)
            failed = True
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
