#!/usr/bin/env python3
"""Linux-only CLI deadline. Own one process group, reap it, never remove files."""
import ctypes
import os
import selectors
import signal
import subprocess
import sys
import time


def main():
    # Reparent orphaned Git/helper grandchildren here rather than container PID 1.
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        return 125
    timeout_ms, grace_ms = int(sys.argv[1]), int(sys.argv[2])
    if not 1 <= timeout_ms <= 180000 or not 1 <= grace_ms <= 5000:
        return 125
    child = None
    deadline = time.monotonic() + timeout_ms / 1000
    stopping = False
    kill_at = None
    forced = False
    output = bytearray()

    def stop(_signum=None, _frame=None):
        nonlocal stopping, kill_at
        if stopping:
            return
        stopping = True
        kill_at = time.monotonic() + grace_ms / 1000
        try:
            if child is not None:
                os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    if stopping:
        return 124
    child = subprocess.Popen(sys.argv[3:], start_new_session=True, stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    if stopping:  # signal during Popen must not leave its just-created group running
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    while True:
        now = time.monotonic()
        if now >= deadline:
            stop()
        if kill_at is not None and now >= kill_at:
            try:
                os.killpg(child.pid, signal.SIGKILL)
                forced = True
            except ProcessLookupError:
                pass
            kill_at = None
        for key, _ in selector.select(0.025):
            chunk = os.read(key.fd, 65536)
            if not chunk:
                selector.unregister(key.fileobj)
                child.stdout.close()
            elif len(output) + len(chunk) > 65536:
                stop()  # bounded output; never forward partial/oversized JSON
                output.clear()
            elif not stopping:
                output.extend(chunk)
        parent_code = child.poll()
        if parent_code is not None:
            # poll reaps the direct child first. Only adopted descendants remain.
            remaining = False
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                    if pid == 0:
                        remaining = True
                        break
                except ChildProcessError:
                    break
            if remaining:
                stop()  # a CLI exit never licenses descendants to continue
            elif not selector.get_map():
                break
    selector.close()
    if stopping:
        # No stdout from an interrupted operation can masquerade as success.
        return 126 if forced or parent_code is None or parent_code < 0 else 124
    sys.stdout.buffer.write(output)
    return parent_code if parent_code is not None and parent_code >= 0 else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError):
        sys.exit(125)
