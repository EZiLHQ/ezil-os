"""Retarget only active Noble regional archive source tokens for an isolated bake."""
from pathlib import Path
import re
import stat
import sys

MIRROR = re.compile(r"https?://ap-south-1\.ec2\.archive\.ubuntu\.com/ubuntu/?\Z")
LEGACY_URI = re.compile(r"^([ \t]*deb(?:-src)?[ \t]+(?:\[[^\]\n]+\][ \t]+)?)(\S+)", re.M)
FIELD = re.compile(r"([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)")
ROOT = Path("/etc/apt")
BACKUP = Path("/run/ezil-native-candidate-apt")


def replace_deb822(paragraph, snapshot):
    lines = paragraph.splitlines(keepends=True)
    fields = {}
    field = None
    for i, line in enumerate(lines):
        if line.lstrip().startswith("#"):
            continue
        matched = FIELD.fullmatch(line.rstrip("\r\n"))
        if matched:
            field = matched[1].lower()
            fields.setdefault(field, []).append((i, matched.start(2), matched[2]))
        elif line[:1] in (" ", "\t") and field:
            fields[field].append((i, 0, line))
        else:
            field = None
    enabled = " ".join(value.strip() for _, _, value in fields.get("enabled", ())).lower()
    types = {word for _, _, value in fields.get("types", ()) for word in value.split()}
    if enabled not in ("", "yes") or types.isdisjoint(("deb", "deb-src")):
        return paragraph
    for index, start, _ in fields.get("uris", ()):
        lines[index] = lines[index][:start] + re.sub(
            r"\S+", lambda token: snapshot if MIRROR.fullmatch(token[0]) else token[0],
            lines[index][start:],
        )
    return "".join(lines)


def replace_sources(text, name, snapshot):
    if name.endswith(".list"):
        return LEGACY_URI.sub(
            lambda match: match[1] + snapshot if MIRROR.fullmatch(match[2]) else match[0], text
        )
    paragraphs = re.split(r"(\r?\n[ \t]*\r?\n)", text)
    paragraphs[::2] = [replace_deb822(paragraph, snapshot) for paragraph in paragraphs[::2]]
    return "".join(paragraphs)


def source_files(root):
    legacy = root / "sources.list"
    if legacy.exists() or legacy.is_symlink():
        yield legacy
    for path in sorted((root / "sources.list.d").iterdir()):
        if re.fullmatch(r"[A-Za-z0-9_.-]+\.(?:list|sources)", path.name):
            yield path


def stage(root, backup, timestamp):
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", timestamp):
        raise SystemExit("Invalid Ubuntu snapshot pin")
    snapshot = f"https://snapshot.ubuntu.com/ubuntu/{timestamp}"
    changes = []
    for path in source_files(root):
        meta = path.lstat()
        if not stat.S_ISREG(meta.st_mode) or meta.st_uid != 0 or meta.st_mode & 0o022:
            raise SystemExit("Untrusted APT source file")
        old = path.read_bytes()
        new = replace_sources(old.decode(), path.name, snapshot).encode()
        if old != new:
            changes.append((path.relative_to(root), old, new))
    if not changes:
        raise SystemExit("Expected active ap-south-1 Ubuntu archive URI is absent")
    backup.mkdir(mode=0o700)
    (backup / "sources.list.d").mkdir(mode=0o700)
    for relative, old, new in changes:
        (backup / relative).write_bytes(old)
        (root / relative).write_bytes(new)
    print(f"Staged signed Ubuntu archive snapshot {timestamp} in {len(changes)} source file(s)")


if __name__ == "__main__":
    stage(ROOT, BACKUP, sys.argv[1])
