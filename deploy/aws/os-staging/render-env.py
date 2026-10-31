#!/usr/bin/env python3
"""Fetch the staging JSON using the EC2 role; emit key names only."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

SECRET_ID = "ezil-os/billing-staging/app"
REQUIRED = frozenset("""
NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY SUPABASE_DATABASE_URL AUTH0_CLIENT_ID AUTH0_SECRET_ID
STRIPE_SECRET STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET CRON_SECRET
BILLING_USAGE_HMAC_SECRET
""".split())
OPTIONAL = frozenset("""
CLOUDFLARE_GUACAMOLE_WORKER_URL CLOUDFLARE_GUACAMOLE_HMAC_SECRET
BILLING_TAB_ENABLED PRICING_PAGE_ENABLED CHECKOUT_ENABLED BILLING_ENFORCEMENT
EZIL_AWS_COMPUTERS_ENABLED EZIL_AWS_CANARY_USER_IDS EZIL_AWS_CANARY_SINCE
EZIL_AWS_USER_MONTHLY_HOURS EZIL_AWS_GLOBAL_MONTHLY_HOURS
EZIL_AWS_USER_MONTHLY_EGRESS_GB EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB
EZIL_AWS_KILL_SWITCH EZIL_AWS_ENROLL_URL EZIL_AWS_WAKE_MODE
EZIL_AWS_LIFECYCLE_USERDATA_NONCE EZIL_AWS_BROWSER_ZONE
EZIL_AWS_IDENTITY_CERTS EZIL_AWS_PLUS_PLAN_IDS EZIL_AWS_LIFECYCLE_DEPLOYMENTS
EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET AWS_REGIONS AWS_MAX_RUNNING
BILLING_FUNDING_URL BILLING_FUNDING_HMAC_SECRET
EZIL_OS_FEEDBACK EZIL_OS_FEEDBACK_SCREENSHOTS FEEDBACK_PILOT_EMAILS FEEDBACK_ADMIN_EMAILS
EZIL_WORKS_PROJECT_REPO_ORIGIN
""".split())
# Exactly the two region-derived names used by aws-config.ts / aws-clients.ts.
REGIONAL = re.compile(
    r"EZIL_AWS_(?:MAX_RUNNING|APP_CALLER_ROLE_ARN)_"
    r"[A-Z]{2}_(?:NORTH|SOUTH|EAST|WEST|CENTRAL|NORTHEAST|SOUTHEAST|NORTHWEST|SOUTHWEST)_[1-9]"
)


class RenderError(Exception):
    pass


def validate(values):
    if not isinstance(values, dict):
        raise RenderError("Expected a JSON object")
    if any(key not in REQUIRED | OPTIONAL and not REGIONAL.fullmatch(key) for key in values):
        raise RenderError("Unknown key refused")
    if REQUIRED - values.keys():
        raise RenderError("Missing required key")
    for value in values.values():
        if not isinstance(value, str) or not value or value != value.strip():
            raise RenderError("Expected nonempty strings without surrounding whitespace")
        if any(c in value for c in "\r\n\0"):
            raise RenderError("Newline or NUL refused")
    if len(values["CRON_SECRET"]) < 32:
        raise RenderError("CRON_SECRET requires at least 32 characters")
    return values


def fetch_secret():
    # Deliberately exclude profiles, static credentials and container providers.
    # Empty config selectors prevent the CLI from reading credential files.
    environment = {
        "PATH": os.defpath + ":/usr/local/bin",
        "AWS_CONFIG_FILE": "/dev/null",
        "AWS_SHARED_CREDENTIALS_FILE": "/dev/null",
        "AWS_EC2_METADATA_DISABLED": "false",
    }
    result = subprocess.run(
        ["aws", "--region", "ap-south-1", "--no-cli-pager", "secretsmanager",
         "get-secret-value", "--secret-id", SECRET_ID, "--output", "json"],
        env=environment, capture_output=True, text=True, check=False, timeout=60,
    )
    if result.returncode:
        raise RenderError("Secrets Manager read failed")
    return json.loads(json.loads(result.stdout)["SecretString"])


def atomic_write(path, content):
    fd, temporary = tempfile.mkstemp(prefix=".render-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), 0, 0)
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def render(values, directory=Path("/etc/ezil-os-staging")):
    values = validate(values)  # Validate everything before changing either file.
    if os.geteuid() != 0:
        raise RenderError("Run as root on the staging host")
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    os.chmod(directory, 0o700)
    os.chown(directory, 0, 0)
    # Compose >=2.30 format: raw injects process.env directly. DO NOT escape $
    # here or source this file. A Next .env file would instead require \$;
    # this image contains no .env files and @next/env preserves process.env.
    atomic_write(directory / "app.env", "".join(f"{k}={values[k]}\n" for k in sorted(values)))
    # systemd EnvironmentFile double quotes: escape backslash and quote only.
    # No shell is involved and systemd does not expand $ in EnvironmentFile.
    cron = values["CRON_SECRET"].replace("\\", "\\\\").replace('"', '\\"')
    atomic_write(directory / "cron.env", f'CRON_SECRET="{cron}"\n')
    print("\n".join(sorted(values)))


def main():
    try:
        if os.geteuid() != 0:
            raise RenderError("Run as root on the staging host")
        render(fetch_secret())
    except Exception:
        # Never echo AWS stderr, JSON parser context, values, or tracebacks.
        print("Environment rendering failed; check JSON keys, values, IAM and connectivity.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
