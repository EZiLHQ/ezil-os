#!/usr/bin/env python3
"""Host-agent unit runner: no Docker, mounts, AWS, or network sockets.

The privileged run-all.sh remains the integration runner. Its TCP EdgeE2E
tests are explicitly excluded here; all other discovered Python tests run.
"""
from pathlib import Path
import socket
import sys
import unittest
from unittest import mock


def cases(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from cases(item)
        else:
            yield item


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    found = list(cases(unittest.defaultTestLoader.discover(str(Path(__file__).parent))))
    excluded = [t for t in found if t.id().startswith("test_edge.EdgeE2E.")]
    suite = unittest.TestSuite(t for t in found if t not in excluded)
    print(f"Offline host-agent suite: {suite.countTestCases()} tests; {len(excluded)} TCP integration tests excluded",
          flush=True)
    with mock.patch.object(socket, "socket", side_effect=AssertionError("offline runner forbids sockets")):
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
