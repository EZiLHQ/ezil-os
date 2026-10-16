"""Read-only, bounded-memory check used only before initializing a provisioned disk.

Run in a child process so the guard can enforce a wall-clock timeout even if an
individual device read stalls. No content is printed or written.
"""
import os
import sys
import time

CHUNK_BYTES = 1024 * 1024


def verify(path, seconds, clock=time.monotonic):
    deadline = clock() + seconds
    fd = os.open(path, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        size = os.lseek(fd, 0, os.SEEK_END)
        if size <= 0:
            return "volume_blank_unreadable"
        zero = bytes(CHUNK_BYTES)
        offset = 0
        while offset < size:
            if clock() >= deadline:
                return "volume_blank_timeout"
            chunk = os.pread(fd, min(CHUNK_BYTES, size - offset), offset)
            if clock() >= deadline:
                return "volume_blank_timeout"
            if not chunk:
                return "volume_blank_unreadable"
            if chunk != zero[:len(chunk)]:
                return "volume_not_blank"
            offset += len(chunk)
        return None
    finally:
        os.close(fd)


if __name__ == "__main__":
    try:
        result = verify(sys.argv[1], float(sys.argv[2]))
    except (OSError, ValueError, IndexError):
        result = "volume_blank_unreadable"
    if result:
        print(result)
        sys.exit(1)
