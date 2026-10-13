#!/usr/bin/env python3
"""Reject incomplete or contradictory real-container acceptance reports."""
import json
import sys
import xml.etree.ElementTree as ET
from collections import Counter

def validate(report, inventory):
    root = ET.parse(report).getroot()
    with open(inventory, encoding="utf-8") as stream:
        required = json.load(stream)
    if not required or any(not names for names in required.values()):
        raise ValueError("Required test inventory must be nonempty")
    for node in root.iter():
        if node.tag in ("failure", "error", "skipped"):
            raise ValueError("JUnit contains " + node.tag)
        if node.tag in ("testsuites", "testsuite"):
            for key in ("failures", "errors", "skipped", "disabled"):
                if int(node.get(key, "0")) != 0:
                    raise ValueError("JUnit reports nonzero " + key)
    cases = list(root.iter("testcase"))
    if not cases:
        raise ValueError("JUnit has no test cases")
    if root.get("tests") is not None and int(root.get("tests")) != len(cases):
        raise ValueError("JUnit total does not match recorded cases")
    for suite in root.iter("testsuite"):
        suite_cases = list(suite.iter("testcase"))
        if suite.get("tests") is not None and int(suite.get("tests")) != len(suite_cases):
            raise ValueError("JUnit suite total does not match recorded cases")
    for path, names in required.items():
        counts = Counter(c.get("name") for c in cases if
                         c.get("file", "").replace("\\", "/").removeprefix("./").endswith("/" + path)
                         or c.get("file", "").removeprefix("./") == path)
        for name in names:
            if counts[name] != 1:
                raise ValueError(f"Required case must appear exactly once: {path}: {name} (got {counts[name]})")
    return len(cases)

if __name__ == "__main__":
    try:
        print(f"Verified {validate(sys.argv[1], sys.argv[2])} JUnit cases against required identities")
    except (OSError, ValueError, KeyError, ET.ParseError, IndexError) as exc:
        print(f"JUnit acceptance failed: {exc}", file=sys.stderr)
        sys.exit(1)
