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


def aws(*args):
    return subprocess.run(
        ["aws", "dynamodb", *args, "--table-name", TABLE, "--region", REGION,
         "--output", "json"],
        text=True, capture_output=True, check=False,
    )


def acquire(owner, ttl, wait):
    deadline = time.monotonic() + wait
    while True:
        now = int(time.time())
        item = {"scope": {"S": SCOPE}, "owner": {"S": owner},
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
            print(f"Staging lease acquired by {owner} until {now + ttl}")
            return 0
        if "ConditionalCheckFailedException" not in result.stderr:
            print("AWS staging lease request failed; check DynamoDB permissions and region", file=sys.stderr)
            return 1
        if time.monotonic() >= deadline:
            print("Staging is reserved by another run; timed out waiting", file=sys.stderr)
            return 2
        time.sleep(min(20, max(1, deadline - time.monotonic())))


def release(owner):
    result = aws(
        "delete-item", "--key", json.dumps({"scope": {"S": SCOPE}}),
        "--condition-expression", "#o = :owner",
        "--expression-attribute-names", json.dumps({"#o": "owner"}),
        "--expression-attribute-values", json.dumps({":owner": {"S": owner}}),
    )
    if result.returncode == 0:
        print(f"Staging lease released by {owner}")
        return 0
    if "ConditionalCheckFailedException" in result.stderr:
        print("Staging lease is no longer owned by this run", file=sys.stderr)
        return 2
    print("AWS staging lease release failed", file=sys.stderr)
    return 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["acquire", "release"])
    parser.add_argument("--owner", required=True)
    parser.add_argument("--ttl", type=int, default=5400)
    parser.add_argument("--wait", type=int, default=1800)
    args = parser.parse_args()
    if not args.owner or len(args.owner) > 200 or args.ttl < 1 or args.ttl > 7200 or args.wait < 0:
        parser.error("invalid owner, ttl, or wait")
    return acquire(args.owner, args.ttl, args.wait) if args.command == "acquire" else release(args.owner)


if __name__ == "__main__":
    sys.exit(main())
