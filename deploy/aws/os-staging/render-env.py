#!/usr/bin/env python3
"""Fetch the environment's JSON using the EC2 role; emit key names only.

Usage: render-env.py [staging|production]; no argument means staging.
"""
import base64
import json
import os
from pathlib import Path
import re
import ssl
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
# Native consent and app-to-Host delivery are independently disabled by default.
# Only the production app receives these explicit configuration names. The app
# validates complete descriptors, signature keys, wrapping keys and service pins.
PRODUCTION_NATIVE = frozenset("""
EZIL_NATIVE_SESSIONS EZIL_NATIVE_SESSIONS_ORIGIN EZIL_NATIVE_AUTH_INTENTS
EZIL_NATIVE_AUTH_CLIENT_IDS EZIL_NATIVE_HOST_TRANSPORT EZIL_NATIVE_RUNTIME_CONTROL
EZIL_NATIVE_AUTHORIZATION EZIL_NATIVE_AUTHORIZATION_ISSUER EZIL_NATIVE_AUTHORIZATION_AUDIENCE
EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY
EZIL_NATIVE_AUTHORIZATION_POLICY_ID EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL
EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT EZIL_NATIVE_GRANT_WRAPPING_KEY_ID EZIL_NATIVE_GRANT_WRAPPING_KEY
EZIL_NATIVE_CONSENT_BUDGET_MICRO EZIL_NATIVE_CONSENT_EPOCH EZIL_NATIVE_CONSENT_TTL_SECONDS
EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR EZIL_NATIVE_DEPLOYMENT_DESCRIPTOR_SHA256 EZIL_NATIVE_RUNTIME_MANIFEST_SHA256
EZIL_NATIVE_GATEWAY_POLICY_ID EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT
EZIL_NATIVE_QUALIFICATION_TARGET
""".split())
ASSIGNMENT_GATE = "EZIL_ASSIGNMENT_PRODUCTION_ENABLED"
ASSIGNMENT_SIGNER = "UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET"
ASSIGNMENT_CA = "UNIVERSE_ASSIGNMENT_API_CA_PEM"
PRODUCTION_ASSIGNMENT = frozenset((ASSIGNMENT_GATE, ASSIGNMENT_SIGNER, ASSIGNMENT_CA))
PRODUCTION_UNIVERSE_ORIGIN = "https://universe.ezil.work"
ASSIGNMENT_CA_MAX_LENGTH = 16384
ASSIGNMENT_CA_PEM = re.compile(
    r"-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=\n]+)\n-----END CERTIFICATE-----\n?"
)
PRODUCTION_BROWSER_GATE = "EZIL_DELEGATED_BROWSER_PROD_CANARY"
PRODUCTION_BROWSER_PINS = (
    "EZIL_BROWSER_PROD_CANARY_USER_ID", "EZIL_BROWSER_PROD_CANARY_COMPUTER_ID",
    "EZIL_BROWSER_PROD_CANARY_TEST_ORIGIN",
)
PRODUCTION_BROWSER = frozenset((PRODUCTION_BROWSER_GATE, *PRODUCTION_BROWSER_PINS))
PRODUCTION_BROWSER_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
NATIVE_SWITCHES = ("EZIL_NATIVE_SESSIONS", "EZIL_NATIVE_AUTH_INTENTS",
                   "EZIL_NATIVE_HOST_TRANSPORT", "EZIL_NATIVE_RUNTIME_CONTROL")
# Delegated computer reads (app/src/server/api/delegation-core.ts): the receiver treats a missing or
# unsafe pin as "not configured" and anything but the exact gate value "enabled" as off, so the
# renderer refuses what the receiver would silently ignore. Off unless the gate is "enabled".
DELEGATION_GATE = "EZIL_DELEGATED_COMPUTER_READS"
EDITOR_SWITCHES = ("EZIL_DELEGATED_EDITOR_SESSIONS", "EZIL_EDITOR_BRIDGE", "EZIL_EDITOR_BRIDGE_CONTROLS")
ONBOARDING_GATE = "EZIL_DELEGATED_ONBOARDING"
MCP_BOOTSTRAP_CLIENT = "EZIL_MCP_IDENTITY_BOOTSTRAP_AUTH0_CLIENT_ID"
EDITOR_PRODUCER_PINS = ("EZIL_EDITOR_WORKER_ORIGIN", "EZIL_EDITOR_WORKER_PROTOCOL")
OS_PUBLIC_ORIGIN = "EZIL_OS_PUBLIC_ORIGIN"
PREVIEW_TOKEN_V2 = "EZIL_PREVIEW_TOKEN_V2"
PRODUCTION_EDITOR = frozenset((*EDITOR_SWITCHES, ONBOARDING_GATE, MCP_BOOTSTRAP_CLIENT, *EDITOR_PRODUCER_PINS, OS_PUBLIC_ORIGIN, PREVIEW_TOKEN_V2))
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
    allowed = REQUIRED | OPTIONAL
    if environment == "production":
        allowed |= PRODUCTION_NATIVE | PRODUCTION_BROWSER | PRODUCTION_ASSIGNMENT | PRODUCTION_EDITOR
    if any(key not in allowed and not REGIONAL.fullmatch(key) for key in values):
        raise RenderError("Unknown key refused")
    if REQUIRED - values.keys():
        raise RenderError("Missing required key")
    for key, value in values.items():
        if key == ASSIGNMENT_CA and isinstance(value, str) and value:
            continue  # The production CA validator below handles complete PEM input.
        if not isinstance(value, str) or not value or value != value.strip():
            raise RenderError("Expected nonempty strings without surrounding whitespace")
        if any(c in value for c in "\r\n\0"):
            raise RenderError("Newline or NUL refused")
    if len(values["CRON_SECRET"]) < 32:
        raise RenderError("CRON_SECRET requires at least 32 characters")
    validate_delegation(values, environment)
    if environment == "production":
        validate_production(values)
        validate_production_editor(values)
        return validate_production_assignment(values)
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


def validate_production_editor(values):
    """Opt-in production candidate only; never synthesize gates or reuse staging pins."""
    switches = tuple(values.get(name) for name in EDITOR_SWITCHES)
    onboarding = values.get(ONBOARDING_GATE)
    if any(value not in (None, "enabled", "disabled") for value in (*switches, onboarding)):
        raise RenderError("Editor and onboarding switches must be exactly enabled or disabled")
    enabled_editor = "enabled" in switches
    if OS_PUBLIC_ORIGIN in values and values[OS_PUBLIC_ORIGIN] != "https://os.ezil.work":
        raise RenderError("Production OS public origin must be canonical")
    producer = tuple(values.get(name) for name in EDITOR_PRODUCER_PINS)
    if producer != (None, None) and producer != ("https://api-desktop.ezil.org", "2"):
        raise RenderError("Editor producer pins require the canonical production Worker and protocol 2")
    preview = values.get(PREVIEW_TOKEN_V2)
    if preview not in (None, "0", "1"):
        raise RenderError("Preview token v2 must be exactly 0 or 1")
    if enabled_editor and switches[:2] != ("enabled", "enabled"):
        raise RenderError("Editor requires both session and bridge base switches")
    if enabled_editor or onboarding == "enabled":
        if (values.get(DELEGATION_GATE) != "enabled"
            or any(pin not in values for pin in DELEGATION_PINS)
            or values.get("EZIL_DELEGATION_ISSUER") != "https://connect.ezil.work"
            or values.get("EZIL_DELEGATION_AUDIENCE") != "https://os.ezil.work"):
            raise RenderError("Production editor/onboarding requires canonical Connect and OS delegation pins")
    if (enabled_editor or preview == "1") and (
        values.get("CLOUDFLARE_GUACAMOLE_WORKER_URL") != "https://api-desktop.ezil.org"
        or not values.get("CLOUDFLARE_GUACAMOLE_HMAC_SECRET")
        or producer != ("https://api-desktop.ezil.org", "2")
    ):
        raise RenderError("Production editor requires the canonical authenticated producer Worker")
    if (enabled_editor or onboarding == "enabled") and values.get(OS_PUBLIC_ORIGIN) != "https://os.ezil.work":
        raise RenderError("Production editor/onboarding requires canonical OS public origin")
    client = values.get(MCP_BOOTSTRAP_CLIENT)
    if client is not None and (onboarding != "enabled" or not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", client)):
        raise RenderError("MCP bootstrap requires onboarding and one legitimate upstream Auth0 client ID")


def validate_production_browser(values):
    gate = values.get(PRODUCTION_BROWSER_GATE)
    if gate not in (None, "enabled", "disabled"):
        raise RenderError("Production Browser canary gate must be exactly enabled or disabled")
    pins = tuple(values.get(name) for name in PRODUCTION_BROWSER_PINS)
    if gate == "enabled" or any(pin is not None for pin in pins):
        if not all(pins):
            raise RenderError("Production Browser canary requires the user, computer and test origin pins")
        user, computer, origin = pins
        host = urlsplit(origin).hostname if bare_https_origin(origin) else None
        if not PRODUCTION_BROWSER_UUID.fullmatch(user) or not PRODUCTION_BROWSER_UUID.fullmatch(computer) \
                or not host or "." not in host or not re.search(r"[a-z]", host) or host.endswith(".localhost"):
            raise RenderError("Production Browser canary requires exact UUIDs and a canonical HTTPS DNS test origin")
    if gate == "enabled" and (
        values.get(DELEGATION_GATE) != "enabled"
        or values.get("EZIL_DELEGATION_ISSUER") != "https://connect.ezil.work"
        or values.get("EZIL_DELEGATION_AUDIENCE") != "https://os.ezil.work"
        or values.get("CLOUDFLARE_GUACAMOLE_WORKER_URL", "").removesuffix("/") != "https://api-desktop.ezil.org"
        or not values.get("CLOUDFLARE_GUACAMOLE_HMAC_SECRET")
    ):
        raise RenderError("Production Browser canary requires the canonical connector, OS and Cloudflare Worker pins")


def assignment_ca_env_value(raw):
    """Parse one public trust anchor and pack the canonical PEM into one raw Compose line."""
    if len(raw) > ASSIGNMENT_CA_MAX_LENGTH:
        raise RenderError("Production assignment ingress requires one valid CA certificate")
    pem = raw.replace("\r\n", "\n").replace(r"\r\n", "\n").replace(r"\n", "\n")
    match = ASSIGNMENT_CA_PEM.fullmatch(pem)
    try:
        if not match:
            raise ValueError
        der = base64.b64decode(match[1].replace("\n", ""), validate=True)
        pem = ssl.DER_cert_to_PEM_cert(der)
        trust = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        trust.load_verify_locations(cadata=pem)
        if trust.get_ca_certs(binary_form=True) != [der]:
            raise ValueError
        packed = pem.replace("\n", r"\n")
        if len(packed) > ASSIGNMENT_CA_MAX_LENGTH:
            raise ValueError
        return packed
    except (ValueError, ssl.SSLError):
        raise RenderError("Production assignment ingress requires one valid CA certificate") from None


def validate_production_assignment(values):
    gate = values.get(ASSIGNMENT_GATE)
    if gate not in (None, "0", "1"):
        raise RenderError("Production assignment gate must be exactly 0 or 1")
    if gate != "1":
        if ASSIGNMENT_SIGNER in values or ASSIGNMENT_CA in values:
            raise RenderError("Production assignment credentials require the enabled gate")
        return values
    if values.get("UNIVERSE_PROJECT_REPO_ORIGIN") != PRODUCTION_UNIVERSE_ORIGIN \
            or values.get("BILLING_FUNDING_URL") != PRODUCTION_FUNDING_URL:
        raise RenderError("Production assignments require the canonical Universe and funding origins")
    if len(values.get(ASSIGNMENT_SIGNER, "")) < 32:
        raise RenderError("Production assignment signer requires at least 32 characters")
    if ASSIGNMENT_CA not in values:
        return values
    return {**values, ASSIGNMENT_CA: assignment_ca_env_value(values[ASSIGNMENT_CA])}


def validate_production(values):
    """Pin production to its own API, private database and live Stripe; refuse staging values."""
    validate_production_browser(values)
    if any(values.get(name) not in (None, "0", "1") for name in NATIVE_SWITCHES):
        raise RenderError("Native session, intent, transport and control gates must be exactly 0 or 1")
    if values.get("EZIL_NATIVE_AUTHORIZATION") not in (None, "disabled", "enabled"):
        raise RenderError("EZIL_NATIVE_AUTHORIZATION must be exactly enabled or disabled")
    target = values.get("EZIL_NATIVE_QUALIFICATION_TARGET")
    uuid = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
    if target is not None and not re.fullmatch(rf"{uuid}/{uuid}/i-[0-9a-f]{{8,17}}", target):
        raise RenderError("Native qualification target must pin the computer, owner and instance")
    origin = values.get("EZIL_NATIVE_SESSIONS_ORIGIN")
    if origin is not None and origin not in PRODUCTION_OS_ORIGINS:
        raise RenderError("Native session origin must be a production OS origin")
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
