"""Offline model of a fenced staging app-only swap.

No AWS, filesystem, Docker, SSM, CLI or production adapter is provided.  The
injected Port is deliberately abstract: passing these tests does not authorize
or implement a staging deployment.  See STAGING-APP-ONLY-RELEASE-CONTRACT.md.
Superseded as a design model by rebase_app_swap.py; the operator does not use it.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
import re
from typing import Literal, Protocol

# Placeholder lower bound for offline scenarios; a real adapter must also bind
# the actual command and delivery timeouts into the reviewed plan.
MIN_LEASE_SECONDS = 1200


class Refused(ValueError):
    """The operation cannot safely advance; its pending fence is retained."""


class OutcomeUnknown(Refused):
    """A submission may exist. Inspect and reconcile it; do not resubmit."""


def need(test: bool, message: str) -> None:
    if not test:
        raise Refused(message)


def is_hex(value: str, n: int) -> bool:
    return bool(re.fullmatch(r'[0-9a-f]{%d}' % n, value))


@dataclass(frozen=True)
class Snapshot:
    app_sha: str
    image_id: str
    selector_sha256: str
    bundle_sha256: str
    tuple_sha256: str
    registry_sha256: str
    secret_version: str
    timer_sha256: str
    kill_switch: bool
    healthy: bool


@dataclass(frozen=True)
class Artifact:
    source_sha: str
    image_id: str
    archive_sha256: str
    receipt_sha256: str
    object_version: str
    tag: str


@dataclass(frozen=True)
class Plan:
    operation: Literal['app-swap', 'app-restore']
    target: str
    owner: str
    generation: int
    before: Snapshot
    after: Snapshot
    artifact: Artifact
    rollback: Artifact
    installer_sha256: str
    command_sha256: str
    undoes_plan: str = ''

    def digest(self) -> str:
        return hashlib.sha256(json.dumps(asdict(self), sort_keys=True,
                                         separators=(',', ':')).encode()).hexdigest()


@dataclass(frozen=True)
class Entry:
    generation: int
    plan_sha256: str
    operation: str
    before: Snapshot
    after: Snapshot
    state: Literal['completed', 'aborted'] = 'completed'


@dataclass(frozen=True)
class Pending:
    generation: int
    plan_sha256: str
    operation: str
    before: Snapshot
    after: Snapshot
    owner: str
    phase: Literal['admitted', 'dispatch-uncertain', 'sent']
    command_id: str = ''


@dataclass(frozen=True)
class Ledger:
    latest: Entry
    pending: Pending | None = None


@dataclass(frozen=True)
class Lease:
    owner: str
    remaining_seconds: int


class Port(Protocol):
    """Operations requiring atomic compare-and-swap in a real integration.

    All writes must be durable, locked and fenced in a future real adapter.
    CAS methods must revalidate lease, state, guard and plan under their lock,
    and the remote host must repeat the pinned checks. This module deliberately
    provides no such adapter and cannot enforce those requirements.
    """
    def ledger(self) -> Ledger: ...
    def live(self) -> Snapshot: ...
    def lease(self) -> Lease: ...
    def verify_artifacts(self, plan: Plan) -> bool: ...
    def verify_enforcement(self, plan: Plan) -> bool: ...
    def admit(self, expected: Ledger, pending: Pending) -> None: ...
    def mark_attempt(self, expected: Pending) -> Pending: ...
    def send(self, plan: Plan) -> str: ...
    def record_command(self, expected: Pending, command_id: str) -> Pending: ...
    def command_status(self, command_id: str) -> str: ...
    def confirm_quiescent(self, command_id: str, plan: Plan) -> bool: ...
    def complete(self, expected: Pending) -> None: ...
    def abort(self, expected: Pending) -> None: ...


def validate(plan: Plan) -> None:
    need(plan.operation in ('app-swap', 'app-restore'), 'invalid operation')
    need(plan.target == 'staging' and bool(plan.owner.strip()), 'invalid target or owner')
    need(type(plan.generation) is int and plan.generation > 0, 'invalid generation')
    for state in (plan.before, plan.after):
        need(is_hex(state.app_sha, 40) and is_hex(state.image_id, 64), 'invalid app identity')
        for value in (state.selector_sha256, state.bundle_sha256, state.tuple_sha256,
                      state.registry_sha256, state.timer_sha256):
            need(is_hex(value, 64), 'invalid state digest')
        need(bool(state.secret_version) and state.kill_switch and state.healthy,
             'expected healthy app and closed admission')
    need(plan.before.app_sha != plan.after.app_sha and plan.before.image_id != plan.after.image_id,
         'swap must change the whole app')
    for field in ('tuple_sha256', 'registry_sha256', 'secret_version', 'timer_sha256'):
        need(getattr(plan.before, field) == getattr(plan.after, field), 'non-app state must stay pinned')
    for art in (plan.artifact, plan.rollback):
        need(is_hex(art.source_sha, 40) and is_hex(art.image_id, 64), 'invalid artifact identity')
        need(is_hex(art.archive_sha256, 64) and is_hex(art.receipt_sha256, 64)
             and bool(art.object_version.strip()) and
             bool(re.fullmatch(r'[a-z0-9][a-z0-9_.-]{0,127}', art.tag)), 'invalid immutable artifact pin')
    need(plan.artifact.tag != plan.rollback.tag, 'candidate and rollback tags must differ')
    need((plan.artifact.source_sha, plan.artifact.image_id) == (plan.after.app_sha, plan.after.image_id),
         'target artifact does not match expected app')
    need((plan.rollback.source_sha, plan.rollback.image_id) == (plan.before.app_sha, plan.before.image_id),
         'rollback artifact does not match current app')
    need(is_hex(plan.installer_sha256, 64) and is_hex(plan.command_sha256, 64), 'invalid installer pin')
    need((plan.operation == 'app-swap' and plan.undoes_plan == '') or
         (plan.operation == 'app-restore' and is_hex(plan.undoes_plan, 64)), 'invalid restore link')



def validate_archive_tags(tags: tuple[str, ...], expected_tag: str,
                          expected_image_id: str, existing_tags: dict[str, str],
                          allow_existing_matching: bool = False) -> None:
    """Model the policy after a trusted archive parser, before docker load.

    This is not an archive parser and cannot prove what bytes would be loaded.
    """
    need(tags == (expected_tag,), 'unexpected archive tag set')
    existing = existing_tags.get(expected_tag)
    need(existing is None or (allow_existing_matching and existing == expected_image_id),
         'archive would reuse or move an existing tag')


def check_lease(port: Port, owner: str, minimum: int) -> None:
    lease = port.lease()
    need(lease.owner == owner and lease.remaining_seconds >= minimum, 'lease unavailable or expiring')


def prepare(port: Port, plan: Plan, minimum_lease_seconds: int) -> Pending:
    validate(plan)
    need(type(minimum_lease_seconds) is int and minimum_lease_seconds >= MIN_LEASE_SECONDS, 'invalid lease bound')
    check_lease(port, plan.owner, minimum_lease_seconds)
    ledger = port.ledger()
    need(ledger.pending is None, 'another operation is pending')
    need(ledger.latest.generation == plan.generation and ledger.latest.after == plan.before,
         'ledger generation or before state changed')
    if plan.operation == 'app-restore':
        need(ledger.latest.state == 'completed' and ledger.latest.operation == 'app-swap' and
             ledger.latest.plan_sha256 == plan.undoes_plan,
             'restore must target the latest completed swap')
        need(ledger.latest.before == plan.after, 'restore does not match swap before state')
    need(port.live() == plan.before, 'live before state changed')
    need(port.verify_artifacts(plan), 'artifact verification failed')
    need(port.verify_enforcement(plan), 'legacy mutation paths are not fenced')
    pending = Pending(plan.generation + 1, plan.digest(), plan.operation,
                      plan.before, plan.after, plan.owner, 'admitted')
    port.admit(ledger, pending)
    need(port.ledger().pending == pending, 'pending fence not confirmed')
    return pending


def matching_pending(port: Port, plan: Plan) -> Pending:
    pending = port.ledger().pending
    need(pending is not None and pending.plan_sha256 == plan.digest() and
         pending.owner == plan.owner and pending.operation == plan.operation and
         pending.generation == plan.generation + 1 and
         pending.before == plan.before and pending.after == plan.after,
         'pending plan or owner mismatch')
    return pending


def dispatch(port: Port, plan: Plan, minimum_lease_seconds: int) -> str:
    """Submit at most once: persist an uncertain marker before calling send."""
    validate(plan)
    need(type(minimum_lease_seconds) is int and minimum_lease_seconds >= MIN_LEASE_SECONDS, 'invalid lease bound')
    pending = matching_pending(port, plan)
    if pending.phase != 'admitted':
        raise OutcomeUnknown('command may already exist; inspect it without resubmitting')
    check_lease(port, plan.owner, minimum_lease_seconds)
    need(port.live() == plan.before and port.verify_artifacts(plan), 'inputs changed before submission')
    need(port.verify_enforcement(plan), 'legacy mutation paths are not fenced')
    uncertain = port.mark_attempt(pending)
    need(uncertain.phase == 'dispatch-uncertain' and uncertain.plan_sha256 == plan.digest()
         and port.ledger().pending == uncertain,
         'attempt marker was not persisted')
    try:
        command_id = port.send(plan)
        if not isinstance(command_id, str) or not command_id.strip():
            raise ValueError('missing command ID')
        recorded = port.record_command(uncertain, command_id)
        if recorded.phase != 'sent' or recorded.command_id != command_id:
            raise ValueError('command journal mismatch')
    except Exception as exc:
        raise OutcomeUnknown('submission or command journal outcome unknown; retain fence') from exc
    return command_id


def finish(port: Port, plan: Plan) -> None:
    """Complete only after a known successful command and exact app readback."""
    validate(plan)
    pending = matching_pending(port, plan)
    need(pending.phase == 'sent' and bool(pending.command_id), 'command identity is unknown')
    check_lease(port, plan.owner, 1)
    need(port.command_status(pending.command_id) == 'Success', 'command is not confirmed successful')
    need(port.live() == plan.after, 'post-install state differs; reconcile under the fence')
    port.complete(pending)


def abort_confirmed_failure(port: Port, plan: Plan) -> None:
    """Abort only a known terminal failure whose complete before state is intact."""
    validate(plan)
    pending = matching_pending(port, plan)
    need(pending.phase == 'sent' and bool(pending.command_id), 'command identity is unknown')
    check_lease(port, plan.owner, 1)
    need(port.command_status(pending.command_id) == 'Failed', 'failure is not confirmed')
    need(port.confirm_quiescent(pending.command_id, plan), 'host mutation activity is not proven quiescent')
    need(port.live() == plan.before, 'failed operation changed state; reconcile under the fence')
    port.abort(pending)
