#!/usr/bin/env python3
"""Validate baked lower identities and Debian package metadata, without Docker."""
import argparse
import json
from pathlib import Path
import re


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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--current", required=True)
    parser.add_argument("--previous", default="")
    parser.add_argument("--lowers-dir", type=Path, default=Path("/var/lib/ezil/lowers"))
    parser.add_argument("--config-dir", type=Path, default=Path("/etc/ezil-host"))
    args = parser.parse_args()
    validate(args.lowers_dir, args.config_dir, args.current, args.previous)
