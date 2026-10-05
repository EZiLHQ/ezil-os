#!/usr/bin/env python3
"""Cross-repository staging lease backed by DynamoDB conditional writes.

Uses the instance role or GitHub OIDC credentials through the AWS CLI. Lease
expiry is checked in the write condition, so DynamoDB TTL cleanup is optional.
"""
import argparse
import json
import subprocess
import sys
import time

TABLE = "ezil-ci-staging"
REGION = "us-east-1"
SCOPE = "shared-staging"
# The staging job can run for 150 minutes, including the 90-minute acceptance
# step. Lease validity is independent of the shorter OIDC credential session.
MAX_LEASE_TTL_SECONDS = 10_800


def aws(*args):
    return subprocess.run(
        ["aws", "dynamodb", *args, "--table-name", TABLE, "--region", REGION,
         "--output", "json"],
        text=True, capture_output=True, check=False,
    )


def acquire(owner, ttl, wait, scope=SCOPE):
    deadline = time.monotonic() + wait
    while True:
        now = int(time.time())
        item = {"scope": {"S": scope}, "owner": {"S": owner},
                "expires_at": {"N": str(now + ttl)}}
        result = aws(
            "put-item", "--item", json.dumps(item),
            "--condition-expression",
            "attribute_not_exists(#s) OR #e < :now OR #o = :owner",
            "--expression-attribute-names",
            json.dumps({"#s": "scope", "#e": "expires_at", "#o": "owner"}),
            "--expression-attribute-values",
            json.dumps({":now": {"N": str(now)}, ":owner": {"S": owner}}),
        )
        if result.returncode == 0:
            print(f"Shared lease acquired by {owner} until {now + ttl}")
            return 0
        if "ConditionalCheckFailedException" not in result.stderr:
            print("AWS shared lease request failed; check DynamoDB permissions and region", file=sys.stderr)
            return 1
        if time.monotonic() >= deadline:
            print("Scope is reserved by another run; timed out waiting", file=sys.stderr)
            return 2
        time.sleep(min(20, max(1, deadline - time.monotonic())))


def release(owner, scope=SCOPE):
    result = aws(
        "delete-item", "--key", json.dumps({"scope": {"S": scope}}),
        "--condition-expression", "#o = :owner",
        "--expression-attribute-names", json.dumps({"#o": "owner"}),
        "--expression-attribute-values", json.dumps({":owner": {"S": owner}}),
    )
    if result.returncode == 0:
        print(f"Shared lease released by {owner}")
        return 0
    if "ConditionalCheckFailedException" in result.stderr:
        print("Shared lease is no longer owned by this run", file=sys.stderr)
        return 2
    print("AWS shared lease release failed", file=sys.stderr)
    return 1


def assert_owner(owner, scope=SCOPE):
    result = aws("get-item", "--key", json.dumps({"scope": {"S": scope}}), "--consistent-read")
    if result.returncode:
        print("Lease read failed", file=sys.stderr)
        return 1
    try:
        item = json.loads(result.stdout)["Item"]
        valid = item["owner"]["S"] == owner and int(item["expires_at"]["N"]) > int(time.time()) + 120
    except (KeyError, ValueError, TypeError):
        valid = False
    if not valid:
        print("Lease is absent, expired, or owned by another run", file=sys.stderr)
        return 2
    return 0


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["acquire", "release", "assert"])
    parser.add_argument("--owner", required=True)
    parser.add_argument("--scope", choices=["shared-staging", "shared-production"], default=SCOPE)
    parser.add_argument("--ttl", type=int, default=5400)
    parser.add_argument("--wait", type=int, default=1800)
    args = parser.parse_args()
    if not args.owner or len(args.owner) > 200 or args.ttl < 1 or args.ttl > MAX_LEASE_TTL_SECONDS or args.wait < 0:
        parser.error("invalid owner, ttl, or wait")
    if args.command == "acquire":
        return acquire(args.owner, args.ttl, args.wait, args.scope)
    if args.command == "assert":
        return assert_owner(args.owner, args.scope)
    return release(args.owner, args.scope)


if __name__ == "__main__":
    sys.exit(main())
