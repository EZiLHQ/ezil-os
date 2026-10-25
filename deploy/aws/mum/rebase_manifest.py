"""Contract v1 release validation. No SDK, network, environment or credentials."""
from datetime import datetime
import json
import math
from pathlib import Path
import re

DIGEST = r"sha256:[0-9a-f]{64}"
TUPLE = ("lowerImageDigest", "previousLowerImageDigest", "preparationStateMachineVersionArn", "recoveryStateMachineVersionArn")
PROMOTION = ("amiId", "launchTemplateVersion", "stateMachineVersionArn", *TUPLE)
RESERVED = {"identity", "operators", "operator", "admin", "root", "ops", "deploy", "boundary", "aws", "service"}


def need(ok, message):
    if not ok:
        raise ValueError(message)


def unique(pairs):
    result = {}
    for key, value in pairs:
        need(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def invalid_constant(_):
    raise ValueError("non-finite JSON number")


def finite_float(raw):
    value = float(raw)
    need(math.isfinite(value), "non-finite JSON number")
    return value


def loads(raw):
    return json.loads(raw, object_pairs_hook=unique, parse_constant=invalid_constant, parse_float=finite_float)


def read(path, limit=None):
    with open(path, "rb") as source:
        raw = source.read() if limit is None else source.read(limit + 1)
    need(limit is None or len(raw) <= limit, "JSON exceeds byte limit")
    return loads(raw.decode("utf-8"))


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def image_ref(value, account=None, region=None, repository=None):
    need(isinstance(value, str) and len(value) <= 512 and matches(
        r"[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9][a-z0-9._/-]*@" + DIGEST, value), "invalid immutable ECR reference")
    repo, digest = value.rsplit("@", 1)
    need(repo.count(".amazonaws.com/") == 1, "extra ECR delimiter")
    if account is not None:
        need(repo.startswith(f"{account}.dkr.ecr.{region}.amazonaws.com/"), "foreign ECR account/region")
    if repository is not None:
        need(repo == repository, "ECR repository mismatch")
    return repo, digest


def workflow(value, deployment, suffix):
    base = f"arn:aws:states:{deployment['region']}:{deployment['accountId']}:stateMachine:ezil-{deployment['namespace']}-{suffix}"
    need(isinstance(value, str) and len(value) <= 300 and matches(re.escape(base) + r":[1-9][0-9]*", value), "workflow version identity mismatch")


def deployment_tuple(d):
    present = set(TUPLE) & d.keys()
    need(not present or present == set(TUPLE), "partial rebase deployment tuple")
    if not present:
        return
    need(matches(DIGEST, d["lowerImageDigest"]), "invalid lower digest")
    previous = d["previousLowerImageDigest"]
    need(previous is None or matches(DIGEST, previous) and previous != d["lowerImageDigest"], "invalid previous lower digest")
    for key, suffix in (("stateMachineVersionArn", "lifecycle"), ("preparationStateMachineVersionArn", "rebase-preparation"), ("recoveryStateMachineVersionArn", "recovery")):
        workflow(d[key], d, suffix)


def promoted_release(d, record):
    """Legacy deployments lack the four rebase fields as a group."""
    deployment_tuple(d)
    keys = PROMOTION if set(TUPLE) <= d.keys() else PROMOTION[:3]
    need(all(d.get(k) == record[k] for k in (*keys, "accountId", "region", "namespace", "launchTemplateId")),
         "deployed release is not the promoted app tuple")


def retained_release(d, record):
    need(record in d.get("releases", []), "image predecessor is not retained in live registry")


def _schema(value, rule, schema):
    # Execute the checked-in contract schema using only its explicit keywords.
    if "$ref" in rule:
        return _schema(value, schema["$defs"][rule["$ref"].split("/")[-1]], schema)
    if "anyOf" in rule:
        for option in rule["anyOf"]:
            try:
                _schema(value, option, schema)
                return
            except ValueError:
                pass
        raise ValueError("manifest nullable field type mismatch")
    if "const" in rule:
        need(type(value) is type(rule["const"]) and value == rule["const"], "manifest version mismatch")
    kind = rule.get("type")
    if kind == "object":
        need(isinstance(value, dict) and set(value) == set(rule["required"]), "manifest fields mismatch")
        for key, child in rule["properties"].items():
            _schema(value[key], child, schema)
    elif kind == "string":
        need(isinstance(value, str), "manifest string type mismatch")
        need("pattern" not in rule or matches(rule["pattern"], value), "manifest string pattern mismatch")
        need(len(value) <= rule.get("maxLength", 16384), "manifest string too long")
    elif kind == "null":
        need(value is None, "manifest null type mismatch")


def validate(value, *, target=False, source=False, repository=None):
    need(not (target and source), "legacy source cannot authorize a target")
    schema = read(Path(__file__).with_name("rebase-source-release.schema.json" if source else "rebase-release.schema.json"))
    _schema(value, schema, schema)
    need(len(json.dumps(value, ensure_ascii=False).encode()) <= 16384, "manifest exceeds byte limit")
    need(value["namespace"] not in RESERVED, "reserved namespace")
    need(all(int(n) <= 1073741823 for n in value["recipeVersion"].split(".")), "recipe version exceeds limit")
    parsed = datetime.strptime(value["createdAt"], "%Y-%m-%dT%H:%M:%S.%fZ")
    need(parsed.isoformat(timespec="milliseconds") + "Z" == value["createdAt"], "noncanonical manifest time")
    if source:
        need(matches(DIGEST, value["lowerImageDigest"]), "invalid source lower")
        need(value["previousLowerImageDigest"] != value["lowerImageDigest"], "equal source lowers")
        for key, suffix in (("stateMachineVersionArn", "lifecycle"), ("preparationStateMachineVersionArn", "rebase-preparation"), ("recoveryStateMachineVersionArn", "recovery")):
            if value[key] is not None:
                workflow(value[key], value, suffix)
    else:
        deployment_tuple(value)
    current_repo, _ = image_ref(value["lowerImageRef"], value["accountId"], value["region"], repository)
    previous, ref = value["previousLowerImageDigest"], value["previousLowerImageRef"]
    need((previous is None) == (ref is None), "previous ID/reference must be paired")
    need(not target or previous is not None, "rebase target requires a previous lower")
    if ref is not None:
        image_ref(ref, value["accountId"], value["region"], current_repo)
    return {key: value[key] for key in schema["properties"]}


def load(path, **kwargs):
    return validate(read(path, 16384), **kwargs)
