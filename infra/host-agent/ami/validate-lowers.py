#!/usr/bin/env python3
"""Validate baked lower identities and Debian package metadata, without Docker.

The CLI also checks what the reverse-move export (REVERSE-MOVE-CONTRACT §2.5, T0 (b2)) needs
from the CURRENT lower, at bake time, before the AMI ships: the codec's /usr/bin/python3 and
/usr/bin/git, and every mount destination of desktop.build_export_spec (runc would otherwise
create a missing one inside the shared lower).
"""
import argparse
import json
import os
from pathlib import Path
import re
import stat

# Mirrors desktop.EXPORT_LOWER_DIRS / EXPORT_LOWER_FILES (test_export pins the equality).
EXPORT_LOWER_DIRS = ("proc", "dev", "tmp", "workspace")
EXPORT_LOWER_FILES = ("etc/hosts", "etc/hostname")
EXPORT_PROGRAMS = ("usr/bin/python3", "usr/bin/git")


def regular(path):
    if path.is_symlink() or not path.is_file() or not path.stat().st_size:
        raise ValueError("missing or symlinked lower metadata")
    return path.read_text(encoding="utf-8")


def validate(lowers, config, current, previous):
    ids = [current] + ([previous] if previous else [])
    if len(set(ids)) != len(ids) or any(not re.fullmatch(r"sha256:[0-9a-f]{64}", v) for v in ids):
        raise ValueError("invalid or equal lower IDs")
    for image_id in ids:
        lower = lowers / image_id[7:]
        if lower.is_symlink() or not lower.is_dir():
            raise ValueError("missing lower directory")
        for subdir in ("usr", "etc", "var", "var/lib", "var/lib/dpkg"):
            path = lower / subdir
            if path.is_symlink() or not path.is_dir():
                raise ValueError("missing or symlinked lower directory")
        status = regular(lower / "var/lib/dpkg/status")
        if not re.search(r"^Package: \S+$", status, re.M) or "Status: install ok installed" not in status:
            raise ValueError("missing installed package metadata")
        if regular(lowers / (image_id[7:] + ".image-id")).strip() != image_id:
            raise ValueError("stored lower ID mismatch")
        metadata = json.loads(regular(lowers / (image_id[7:] + ".image-config.json")))
        if set(metadata) != {"Env", "WorkingDir"} or not isinstance(metadata["WorkingDir"], str) or not (
            metadata["Env"] is None or isinstance(metadata["Env"], list) and all(isinstance(v, str) for v in metadata["Env"])
        ):
            raise ValueError("invalid image configuration")
    if regular(config / "lower-image-digest").strip() != current:
        raise ValueError("current lower marker mismatch")
    old_marker = config / "previous-lower-image-digest"
    if previous:
        if regular(old_marker).strip() != previous:
            raise ValueError("previous lower marker mismatch")
    elif old_marker.exists() or old_marker.is_symlink():
        raise ValueError("unexpected previous lower marker")
    if regular(config / "image-config.json") != regular(lowers / (current[7:] + ".image-config.json")):
        raise ValueError("current image configuration mismatch")


def _within(lower, rel, hops=8):
    """rel resolved INSIDE the lower (an absolute link target is lower-relative, as in the
    container), never on the build host. The final path, or None."""
    path = lower / rel
    for _ in range(hops):
        if not path.is_symlink():
            return path
        target = os.readlink(path)
        path = lower / target.lstrip("/") if target.startswith("/") else path.parent / target
        if os.path.commonpath([os.path.normpath(path), os.path.normpath(lower)]) != os.path.normpath(lower):
            return None
    return None


def validate_export(lowers, current):
    lower = lowers / current[7:]
    if any((lower / d).is_symlink() or not (lower / d).is_dir() for d in ("usr", "usr/bin")):
        raise ValueError("export needs a real /usr/bin in the current lower")
    for rel in EXPORT_PROGRAMS:
        path = _within(lower, rel)
        try:
            st = path.stat() if path is not None else None
        except OSError:
            st = None
        if st is None or not stat.S_ISREG(st.st_mode) or not st.st_mode & 0o111:
            raise ValueError(f"export needs /{rel} in the current lower")
    for rel in EXPORT_LOWER_DIRS:
        if (lower / rel).is_symlink() or not (lower / rel).is_dir():
            raise ValueError(f"export mount destination /{rel} missing in the current lower")
    for rel in EXPORT_LOWER_FILES:
        if (lower / rel).is_symlink() or not (lower / rel).is_file():
            raise ValueError(f"export mount destination /{rel} missing in the current lower")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True)
    parser.add_argument("--previous", default="")
    parser.add_argument("--lowers-dir", type=Path, default=Path("/var/lib/ezil/lowers"))
    parser.add_argument("--config-dir", type=Path, default=Path("/etc/ezil-host"))
    args = parser.parse_args()
    validate(args.lowers_dir, args.config_dir, args.current, args.previous)
    validate_export(args.lowers_dir, args.current)
