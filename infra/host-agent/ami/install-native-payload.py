#!/usr/bin/env python3
"""Install one reviewed immutable runtime on a new Image Builder candidate. No live keys or boot state."""
import argparse
import hashlib
import json
import os
import posixpath
import stat
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path, PurePosixPath

ARCHIVE_SHA = "cc81f370de328f59520d5198fd49e4853c898530541e0df989f6e33fe1523114"
ARCHIVE_BYTES = 251050911
INDEX_SHA = "d99b3494538feb2e26e61037a4faa16818c9200c9600228c392ced016bceca9e"
MANIFEST_SHA = "d4dda875013002e6f666907aa5f4007a2282d10d343d5fdac4b741066fa90221"
TEMPLATE_SHA = "d733d2ebbe829601eda2536474a10e521b75dff66372dda01ddf3b048c9131b2"
DRIVER_SHA = "2f2bc86e8e5e75ff42c6872f7e45bb83336cf687fc0ced2bade84ee559086c2c"
PIN = {"manifestSha256": MANIFEST_SHA, "cliVersion": "2.1.310", "nodeAbi": "137"}
MODES = {"0644": 0o644, "0755": 0o755}


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def member_path(path):
    rel = PurePosixPath(path)
    require(path == str(rel) and not rel.is_absolute() and rel.parts
            and rel.parts[0] in ("artifact", "rootfs") and ".." not in rel.parts, "payload member path")
    return rel


def inspect_index(archive):
    members = archive.getmembers()
    by_name = {member.name: member for member in members}
    require(len(by_name) == len(members) < 25000, "payload member inventory")
    index = by_name["payload-index.json"]
    require(index.isfile() and 0 < index.size < (4 << 20), "payload index type/size")
    with archive.extractfile(index) as file:
        raw = file.read()
    require(hashlib.sha256(raw).hexdigest() == INDEX_SHA, "payload index pin")
    inventory = json.loads(raw)
    require(set(inventory) == {"v", "files"} and inventory["v"] == 1, "payload index schema")
    entries = inventory["files"]
    paths = [entry["path"] for entry in entries]
    require(len(paths) == len(set(paths)) and set(by_name) == set(paths) | {"payload-index.json"}
            and sum(entry.get("size", 0) for entry in entries) <= (2 << 30), "payload index inventory")
    paths = {entry["path"]: member_path(entry["path"]) for entry in entries}
    return by_name, sorted(entries, key=lambda entry: (len(paths[entry["path"]].parts), entry["path"]))


def extract_private(archive_file, source, art):
    with tarfile.open(fileobj=archive_file, mode="r:gz") as archive:
        by_name, entries = inspect_index(archive)
        for entry in entries:
            member = by_name[entry["path"]]
            rel = member_path(entry["path"])
            parent = art.trusted_directory(str(source / rel.parent))
            try:
                if entry["type"] == "dir":
                    require(member.isdir() and entry["mode"] == "0755", "payload directory")
                    os.close(art._new_directory_at(parent, rel.name, 0o755))
                elif entry["type"] == "symlink":
                    target = entry["target"]
                    resolved = posixpath.normpath(posixpath.join(str(rel.parent), target))
                    require(member.issym() and member.linkname == target and str(rel).startswith("rootfs/")
                            and not target.startswith("/") and resolved.startswith("rootfs/"), "payload symlink")
                    os.symlink(target, rel.name, dir_fd=parent)
                else:
                    require(entry["type"] == "file" and member.isfile() and member.size == entry["size"]
                            and entry["mode"] in MODES, "payload file")
                    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
                    fd = os.open(rel.name, flags, 0o600, dir_fd=parent)
                    with os.fdopen(fd, "wb") as dest, archive.extractfile(member) as src:
                        digest = hashlib.sha256()
                        for chunk in iter(lambda: src.read(1 << 20), b""):
                            digest.update(chunk)
                            dest.write(chunk)
                        require(digest.hexdigest() == entry["sha256"] and dest.tell() == entry["size"], "payload file digest")
                        dest.flush()
                        os.fchmod(dest.fileno(), MODES[entry["mode"]])
                        os.fsync(dest.fileno())
            finally:
                os.close(parent)


def validate_executables(artifact):
    root = Path(artifact["dir"])
    require(artifact["node"] == "runtime/node", "payload direct Node")
    node = str(root / artifact["node"])
    cli = str(root / artifact["cli"])
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "DISABLE_TELEMETRY": "1", "DISABLE_ERROR_REPORTING": "1"}
    result = subprocess.run([node, "--no-warnings", "-p",
        "JSON.stringify([process.version,process.versions.modules,process.execPath,"
        "require('node:fs').realpathSync('/proc/self/exe'),process.arch,process.platform])"],
        check=True, encoding="utf8", capture_output=True, env=env, cwd="/", timeout=8)
    require(json.loads(result.stdout) == ["v24.15.0", "137", node, node, "x64", "linux"], "payload direct Node ABI/identity")
    result = subprocess.run([cli, "--version"], check=True, encoding="utf8", capture_output=True, env=env, cwd="/", timeout=8)
    require(result.stdout.strip().split(" ", 1)[0] == PIN["cliVersion"], "payload CLI mismatch")



def verified_archive(path, art):
    parent = art.trusted_directory(str(path.parent))
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
    finally:
        os.close(parent)
    file = os.fdopen(fd, "rb")
    try:
        st = os.fstat(fd)
        require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
                and not st.st_mode & 0o022 and st.st_size == ARCHIVE_BYTES, "payload archive identity")
        require(hashlib.file_digest(file, "sha256").hexdigest() == ARCHIVE_SHA, "payload archive pin")
        file.seek(0)
        return file
    except BaseException:
        file.close()
        raise


def host_settings(prefix):
    return {"nativeSessions": "disabled", "nativeRuntimeRoot": str(prefix / "runtime"),
            "nativeRuntimePin": PIN, "nativeRootfs": str(prefix / "templates" / TEMPLATE_SHA)}


def verify_payload(prefix, art, host_lib):
    os.close(art.trusted_directory(str(prefix)))
    directory = art.trusted_directory(str(host_lib / "ezil_host"))
    try:
        fd = os.open("native_driver.mjs", os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, "rb") as file:
            st = os.fstat(fd)
            require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022 and st.st_nlink == 1,
                    "public Host driver identity")
            require(hashlib.file_digest(file, "sha256").hexdigest() == DRIVER_SHA, "public Host driver pin")
    finally:
        os.close(directory)
    artifact = art.load(str(prefix / "runtime"), PIN)
    require(artifact["rootfsTemplateSha256"] == TEMPLATE_SHA
            and hashlib.sha256(art.rootfs_descriptor_bytes(str(prefix / "templates" / TEMPLATE_SHA))).hexdigest() == TEMPLATE_SHA,
            "payload installed rootfs pin")
    validate_executables(artifact)


def install_payload(archive, prefix, art, host_lib, write_file):
    parent = art.trusted_directory(str(prefix.parent), searchable=True)
    try:
        require(not os.path.lexists(prefix), "runtime prefix already exists")
        with verified_archive(archive, art) as file, tempfile.TemporaryDirectory(prefix=".native-stage-", dir=prefix.parent) as scratch:
            root = Path(scratch)
            source = root / "source"
            ready = root / "install"
            source.mkdir(mode=0o700)
            ready.mkdir(mode=0o700)
            extract_private(file, source, art)
            (ready / "runtime").mkdir(mode=0o700)
            (ready / "templates").mkdir(mode=0o700)
            (ready / "runtime").chmod(0o755)
            (ready / "templates").chmod(0o755)
            art.install(str(source / "artifact"), str(ready / "runtime"), PIN)
            os.rename(source / "rootfs", ready / "templates" / TEMPLATE_SHA)
            verify_payload(ready, art, host_lib)
            receipt = {"v": 1, "archiveSha256": ARCHIVE_SHA, "indexSha256": INDEX_SHA, "rootfsTemplateSha256": TEMPLATE_SHA,
                       "publicDriverSha256": DRIVER_SHA, "hostConfiguration": host_settings(prefix)}
            ready_fd = art.trusted_directory(str(ready))
            try:
                write_file(ready_fd, "candidate-install.json", json.dumps(receipt, sort_keys=True).encode() + b"\n", 0o600)
                os.fchmod(ready_fd, 0o755)
                os.fsync(ready_fd)
            finally:
                os.close(ready_fd)
            # Trusted root-owned parent and a fresh build instance. Existing installations are never replaced.
            require(not os.path.lexists(prefix), "runtime prefix already exists")
            os.rename(ready, prefix)
            os.fsync(parent)
    finally:
        os.close(parent)


def configure_off(path, prefix, art, write_file):
    parent = art.trusted_directory(str(path.parent))
    try:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
        with os.fdopen(fd, "rb") as file:
            st = os.fstat(fd)
            require(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1 and not st.st_mode & 0o022
                    and 0 < st.st_size <= 65536, "Host config identity")
            config = json.loads(file.read(65537))
        settings = host_settings(prefix)
        require(isinstance(config, dict) and all(config.get(key, value) == value for key, value in settings.items()),
                "Host config already has a different native deployment")
        config.update(settings)
        write_file(parent, path.name, json.dumps(config, sort_keys=True).encode() + b"\n", stat.S_IMODE(st.st_mode))
    finally:
        os.close(parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("step", choices=("install", "verify"))
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--prefix", type=Path, default=Path("/opt/ezil-native"))
    parser.add_argument("--host-lib", type=Path, default=Path("/opt/ezil-host/lib"))
    parser.add_argument("--agent-config", type=Path)
    args = parser.parse_args()
    try:
        require(os.geteuid() == 0 and args.prefix.is_absolute() and args.host_lib.is_absolute(), "trusted root paths required")
        os.umask(0o077)
        if args.step == "install":
            require(args.archive is not None and args.archive.is_absolute(), "pinned local archive required")
        else:
            require(args.archive is None and args.agent_config is None, "verify is read only")
        require(args.host_lib.resolve(strict=True) == args.host_lib, "Host library must be canonical")
        for directory in (args.host_lib, *args.host_lib.parents):
            st = directory.stat()
            require(stat.S_ISDIR(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022, "Host library ancestry")
        sys.path.insert(0, str(args.host_lib))
        from ezil_host import native_artifact
        from ezil_host.fsops import Refused, write_file_durable_at
        try:
            if args.step == "install":
                install_payload(args.archive, args.prefix, native_artifact, args.host_lib, write_file_durable_at)
                if args.agent_config is not None:
                    configure_off(args.agent_config, args.prefix, native_artifact, write_file_durable_at)
            else:
                verify_payload(args.prefix, native_artifact, args.host_lib)
        except Refused as error:
            raise ValueError(error.code) from error
        print("Private native candidate artifact, direct Node and CLI verified.")
        return 0
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.SubprocessError, tarfile.TarError) as error:
        print("Native candidate payload refused: " + type(error).__name__, file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
