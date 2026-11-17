#!/usr/bin/env python3
"""Fetch the environment's JSON using the EC2 role; emit key names only.

Usage: render-env.py [staging|production]; no argument means staging.
"""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import parse_qs, urlsplit

SECRET_ID = "ezil-os/billing-staging/app"
# Environment -> (secret id, root-only env directory). Staging is the original pair.
ENVIRONMENTS = {
    "staging": (SECRET_ID, Path("/etc/ezil-os-staging")),
    "production": ("ezil-os/production/app", Path("/etc/ezil-os-production")),
}
# Production is pinned to the self-hosted API and the private Postgres listener
# (no proxy in production); staging must never carry either.
PRODUCTION_API_URL = "https://db.ezil.work"
PRODUCTION_DB_HOST = "10.63.20.252"
PRODUCTION_MARKERS = ("db.ezil.work", PRODUCTION_DB_HOST)
# Preview API, preview DB proxy and the staging hostname.
STAGING_MARKERS = ("13-203-99-168.sslip.io", "10.61.20.35", "os-staging.ezil.work")
# Any EZiL or sslip.io host whose name says staging/preview (ai-staging, api-desktop-staging,
# db-preview, ...) or any sslip.io host at all; production only uses named hosts.
STAGING_HOST = re.compile(r"[a-z0-9.-]*(?:staging|preview)[a-z0-9.-]*\.(?:ezil\.work|ezil\.org)|[a-z0-9.-]+\.sslip\.io",
                          re.IGNORECASE)
PRODUCTION_FUNDING_URL = "https://ai.ezil.work"
STAGING_FUNDING_URL = "https://ai-staging.ezil.work"
LIVE_STRIPE = ("pk_live_", "sk_live_", "rk_live_")
REQUIRED = frozenset("""
NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY SUPABASE_DATABASE_URL AUTH0_CLIENT_ID AUTH0_SECRET_ID
STRIPE_SECRET STRIPE_PUBLISHABLE_KEY STRIPE_WEBHOOK_SECRET CRON_SECRET
BILLING_USAGE_HMAC_SECRET
""".split())
OPTIONAL = frozenset("""
AWS_STANDALONE_REPO_OPEN_ENABLED
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
EZIL_OS_FEEDBACK EZIL_OS_FEEDBACK_SCREENSHOTS FEEDBACK_PILOT_EMAILS FEEDBACK_ADMIN_EMAILS FEEDBACK_SMTP2GO_API_KEY
TELEMETRY_ADMIN_EMAILS
UNIVERSE_PROJECT_REPO_ORIGIN
EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEYS
EZIL_DELEGATED_COMPUTER_READS EZIL_DELEGATION_ISSUER EZIL_DELEGATION_AUDIENCE
EZIL_DELEGATION_PUBLIC_JWKS EZIL_DELEGATION_CLIENT_IDS
""".split())
# Delegated computer reads (app/src/server/api/delegation-core.ts): the receiver treats a missing or
# unsafe pin as "not configured" and anything but the exact gate value "enabled" as off, so the
# renderer refuses what the receiver would silently ignore. Off unless the gate is "enabled".
DELEGATION_GATE = "EZIL_DELEGATED_COMPUTER_READS"
DELEGATION_PINS = ("EZIL_DELEGATION_ISSUER", "EZIL_DELEGATION_AUDIENCE",
                   "EZIL_DELEGATION_PUBLIC_JWKS", "EZIL_DELEGATION_CLIENT_IDS")
# Caddy serves exactly these two names for production OS; the audience is the origin the MCP signs.
PRODUCTION_OS_ORIGINS = ("https://os.ezil.work", "https://os-prod.ezil.work")
BARE_HTTPS_ORIGIN = re.compile(
    r"https://(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?::([1-9][0-9]{0,4}))?")
JWK_MEMBERS = frozenset(("kty", "crv", "x", "y", "kid", "alg", "use"))
MAX_PINNED_KEYS = 3
P256_P = 2**256 - 2**224 + 2**192 + 2**96 - 1
P256_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b
# Exactly the two region-derived names used by aws-config.ts / aws-clients.ts.
REGIONAL = re.compile(
    r"EZIL_AWS_(?:MAX_RUNNING|APP_CALLER_ROLE_ARN)_"
    r"[A-Z]{2}_(?:NORTH|SOUTH|EAST|WEST|CENTRAL|NORTHEAST|SOUTHEAST|NORTHWEST|SOUTHWEST)_[1-9]"
)


class RenderError(Exception):
    pass


def validate(values, environment="staging"):
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
    validate_delegation(values, environment)
    if environment == "production":
        validate_production(values)
    elif any(marker in value for value in values.values() for marker in PRODUCTION_MARKERS):
        raise RenderError("Staging refuses production API or database values")
    elif any(value.startswith(LIVE_STRIPE) for value in values.values()):
        raise RenderError("Staging refuses Stripe live-mode keys")
    elif "BILLING_FUNDING_URL" in values and values["BILLING_FUNDING_URL"] != STAGING_FUNDING_URL:
        raise RenderError("Staging BILLING_FUNDING_URL must be https://ai-staging.ezil.work")
    return values


def bare_https_origin(value):
    """Mirror bareHttpsOrigin(): https, lowercase host, optional non-default port, nothing else."""
    match = BARE_HTTPS_ORIGIN.fullmatch(value)
    return bool(match) and (match.group(1) is None or 0 < int(match.group(1)) < 65536 and match.group(1) != "443")


def public_key_member(value):
    """A canonical unpadded base64url string of exactly 32 bytes, as an integer."""
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", value):
        raise RenderError("Delegation JWKS coordinates must be canonical base64url of 32 bytes")
    raw = base64.urlsafe_b64decode(value + "=")
    if base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != value:
        raise RenderError("Delegation JWKS coordinates must be canonical base64url of 32 bytes")
    return int.from_bytes(raw, "big")


def delegation_jwks(raw):
    def no_duplicates(pairs):
        names = [name for name, _ in pairs]
        if len(set(names)) != len(names):
            raise RenderError("Delegation JWKS refuses duplicate members")
        return dict(pairs)

    def no_constant(_):
        raise RenderError("Delegation JWKS refuses non-JSON numbers")

    try:
        jwks = json.loads(raw, object_pairs_hook=no_duplicates, parse_constant=no_constant)
    except (ValueError, RecursionError):
        raise RenderError("EZIL_DELEGATION_PUBLIC_JWKS must be JSON")
    keys = jwks.get("keys") if isinstance(jwks, dict) and set(jwks) == {"keys"} else None
    if not isinstance(keys, list) or not 1 <= len(keys) <= MAX_PINNED_KEYS:
        raise RenderError('EZIL_DELEGATION_PUBLIC_JWKS must be {"keys":[1 to 3 keys]}')
    kids = set()
    for jwk in keys:
        # Public members only: a private member (`d`) means a secret was pasted into a public slot.
        if not isinstance(jwk, dict) or not set(jwk) <= JWK_MEMBERS:
            raise RenderError("Delegation JWKS accepts public key members only")
        if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256" or jwk.get("alg", "ES256") != "ES256" \
                or jwk.get("use", "sig") != "sig":
            raise RenderError("Delegation JWKS keys must be ES256 P-256 signing keys")
        kid = jwk.get("kid")
        if not isinstance(kid, str) or not 1 <= len(kid) <= 128 or kid in kids:
            raise RenderError("Delegation JWKS needs unique kid values of 1 to 128 characters")
        kids.add(kid)
        x, y = public_key_member(jwk.get("x")), public_key_member(jwk.get("y"))
        if x >= P256_P or y >= P256_P or (y * y - (x ** 3 - 3 * x + P256_B)) % P256_P:
            raise RenderError("Delegation JWKS point is not on P-256")


def validate_delegation(values, environment):
    """All-or-nothing, strict, public-only; the gate defaults to off and never turns on by omission."""
    gate = values.get(DELEGATION_GATE)
    if gate not in (None, "enabled", "disabled"):
        raise RenderError(f"{DELEGATION_GATE} must be exactly enabled or disabled")
    present = [pin for pin in DELEGATION_PINS if pin in values]
    if len(present) not in (0, len(DELEGATION_PINS)) or gate == "enabled" and not present:
        raise RenderError("Delegation requires all four pins: issuer, audience, public JWKS and client IDs")
    if not present:
        return
    issuer, audience = values["EZIL_DELEGATION_ISSUER"], values["EZIL_DELEGATION_AUDIENCE"]
    if not bare_https_origin(issuer) or not bare_https_origin(audience) or issuer == audience:
        raise RenderError("Delegation issuer and audience must be different bare https origins")
    in_production = audience in PRODUCTION_OS_ORIGINS
    if environment == "production" and not in_production:
        raise RenderError("Production delegation audience must be a production OS origin")
    if environment != "production" and in_production:
        raise RenderError("Staging refuses a production delegation audience")
    clients = [client for client in re.split(r"[\s,]+", values["EZIL_DELEGATION_CLIENT_IDS"]) if client]
    if not clients or any(len(client) > 512 or client == "*" for client in clients):
        raise RenderError("Delegation client IDs must be explicit, non-empty and not a wildcard")
    delegation_jwks(values["EZIL_DELEGATION_PUBLIC_JWKS"])


def validate_production(values):
    """Pin production to its own API, private database and live Stripe; refuse staging values."""
    if any(marker in value for value in values.values() for marker in STAGING_MARKERS) \
            or any(STAGING_HOST.search(value) for value in values.values()):
        raise RenderError("Production refuses staging or preview values")
    if "BILLING_FUNDING_URL" in values and values["BILLING_FUNDING_URL"] != PRODUCTION_FUNDING_URL:
        raise RenderError("Production BILLING_FUNDING_URL must be https://ai.ezil.work")
    if values["NEXT_PUBLIC_SUPABASE_URL"] != PRODUCTION_API_URL:
        raise RenderError("Production NEXT_PUBLIC_SUPABASE_URL must be https://db.ezil.work")
    try:
        url = urlsplit(values["SUPABASE_DATABASE_URL"])
        pinned = (url.scheme in ("postgres", "postgresql") and url.hostname == PRODUCTION_DB_HOST
                  and url.port == 5432 and url.path not in ("", "/") and not url.fragment
                  and parse_qs(url.query, keep_blank_values=True) == {"sslmode": ["require"]})
    except ValueError:
        pinned = False
    if not pinned:
        raise RenderError("Production SUPABASE_DATABASE_URL must be postgres://ROLE:PASSWORD@10.63.20.252:5432/DB?sslmode=require")
    if not values["STRIPE_PUBLISHABLE_KEY"].startswith("pk_live_") \
            or not values["STRIPE_SECRET"].startswith(("sk_live_", "rk_live_")):
        raise RenderError("Production requires Stripe live-mode keys")


def fetch_secret(secret_id=SECRET_ID):
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
         "get-secret-value", "--secret-id", secret_id, "--output", "json"],
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


def render(values, directory=Path("/etc/ezil-os-staging"), environment="staging"):
    values = validate(values, environment)  # Validate everything before changing either file.
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


def main(argv=()):
    try:
        if len(argv) > 1 or (argv and argv[0] not in ENVIRONMENTS):
            raise RenderError("Usage: render-env.py [staging|production]")
        environment = argv[0] if argv else "staging"
        secret_id, directory = ENVIRONMENTS[environment]
        if os.geteuid() != 0:
            raise RenderError("Run as root on the staging host")
        render(fetch_secret(secret_id), directory, environment)
    except Exception:
        # Never echo AWS stderr, JSON parser context, values, or tracebacks.
        print("Environment rendering failed; check JSON keys, values, IAM and connectivity.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
