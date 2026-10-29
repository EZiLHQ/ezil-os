#!/usr/bin/env python3
"""Workstation build step: derive the production runtime files from the staging ones.

Usage: render-runtime.py SOURCE_DIR OUTPUT_DIR

The checked-in compose.yaml, Caddyfile and cron units are the staging runtime;
OS_ENV=staging ships them as they are. Production is the same files with every
staging name replaced. Each replacement must match exactly once and the result
must not mention staging, so a drifted source fails the build instead of
shipping a half-renamed bundle. render-env.py is copied unchanged: it takes the
environment as its argument on the host.
"""
from pathlib import Path
import shutil
import sys

JOBS = ("telemetry-maintenance", "sandbox-reap", "billing-session-sweep",
        "aws-stop-settle", "pool-replenish", "aws-reconcile")
STAGING, PRODUCTION = "ezil-os-staging", "ezil-os-production"
# Cron stays on the host's own name: before cutover os.ezil.work is Vercel and
# must never receive the production CRON_SECRET; Caddy serves both names after.
CRON_ORIGIN = "https://os-prod.ezil.work"
SITE_ADDRESSES = "os-prod.ezil.work, os.ezil.work"

REPLACEMENTS = {
    "compose.yaml": (
        (f"name: {STAGING}\n", f"name: {PRODUCTION}\n"),
        (f"image: {STAGING}:${{OS_STAGING_TAG:?Set OS_STAGING_TAG}}",
         f"image: {PRODUCTION}:${{OS_PRODUCTION_TAG:?Set OS_PRODUCTION_TAG}}"),
        (f"path: /etc/{STAGING}/app.env\n", f"path: /etc/{PRODUCTION}/app.env\n"),
    ),
    "Caddyfile": (("\nos-staging.ezil.work {\n", f"\n{SITE_ADDRESSES} {{\n"),),
}
for _job in JOBS:
    REPLACEMENTS[f"cron/{STAGING}-{_job}.service"] = (
        ("Description=EZiL OS staging ", "Description=EZiL OS production "),
        (f"EnvironmentFile=/etc/{STAGING}/cron.env\n", f"EnvironmentFile=/etc/{PRODUCTION}/cron.env\n"),
        (f" https://os-staging.ezil.work/api/cron/{_job}\n", f" {CRON_ORIGIN}/api/cron/{_job}\n"),
    )
    REPLACEMENTS[f"cron/{STAGING}-{_job}.timer"] = (
        ("Description=Schedule EZiL OS staging ", "Description=Schedule EZiL OS production "),
        (f"Unit={STAGING}-{_job}.service\n", f"Unit={PRODUCTION}-{_job}.service\n"),
    )


class RenderError(Exception):
    pass


def render_text(name, text):
    for old, new in REPLACEMENTS[name]:
        if text.count(old) != 1:
            raise RenderError(f"{name}: expected exactly one {old.strip()!r}")
        text = text.replace(old, new)
    if "staging" in text.lower():
        raise RenderError(f"{name}: a staging reference survived rendering")
    return text


def render(source, output):
    source, output = Path(source), Path(output)
    cron = {f"cron/{path.name}" for path in (source / "cron").iterdir()}
    if cron != {name for name in REPLACEMENTS if name.startswith("cron/")}:
        raise RenderError("cron/ does not match the known job set")
    (output / "cron").mkdir(parents=True)
    for name in REPLACEMENTS:
        destination = output / name.replace(f"cron/{STAGING}-", f"cron/{PRODUCTION}-")
        destination.write_text(render_text(name, (source / name).read_text()))
    shutil.copyfile(source / "render-env.py", output / "render-env.py")


def main(argv):
    if len(argv) != 2:
        print("Usage: render-runtime.py SOURCE_DIR OUTPUT_DIR", file=sys.stderr)
        return 2
    try:
        render(*argv)
    except (OSError, RenderError) as error:
        print(f"Production runtime rendering failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
