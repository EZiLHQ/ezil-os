#!/usr/bin/env python3
"""Remove pool guards in throwaway copies; each named regression must kill it.
No network, Docker, AWS, or modification of the working implementation.
"""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile

# name, module, exact source, replacement, regression method
MUTATIONS = [
    ('fast-relay-poll', 'desktop', 'def wait_desktop_config(cfg, timeout, poll=0.25', 'def wait_desktop_config(cfg, timeout, poll=1.0', 'Timing.test_relay_poll_detects_arrival_within_quarter_second'),
    ('warm-stop-confirmed', 'pool', 'if desktop.state(cfg) != "absent":', 'if False:', 'Timing.test_warm_stop_requires_absence_before_unmount'),
    ('timing-guard', 'pool', 'timing(cfg, "guardDoneMs")', 'pass', 'Sessions.test_numeric_timings_cross_units_and_preserve_first_observation'),
    ('timing-once', 'pool', 'values.setdefault(phase, round(time.monotonic() * 1000))', 'values[phase] = round(time.monotonic() * 1000)', 'Sessions.test_numeric_timings_cross_units_and_preserve_first_observation'),
    ('warm-force-stop', 'pool', 'desktop.stop(cfg, grace=0, kill=True)', 'desktop.stop(cfg)', 'Lifecycle.test_warm_cleanup_preserves_host_state_and_symlink_targets'),
    ('fast-health-poll', 'pool', 'READY_POLL_SECONDS = 0.25', 'READY_POLL_SECONDS = 1.0', 'Lifecycle.test_readiness_wait_and_timeout'),
    ('timing-number', 'pool', 'type(v) in (int, float)', 'isinstance(v, (int, float))', 'Timing.test_timing_drops_non_numeric_unknown_and_unbounded_values'),
    ('timing-bound', 'pool', '0 <= v <= 9007199254740991', 'True', 'Timing.test_timing_drops_non_numeric_unknown_and_unbounded_values'),
    ('publication-bound', 'pool', 'not 0 <= published <= 4102444800000', 'False', 'Timing.test_claim_publication_is_optional_bounded_numeric'),
    ('single-spec', 'cli', 'if pool.session_record(cfg, lease) is None:', 'if True:', 'Lifecycle.test_claim_mount_enroll_and_switch_into_standard_chain'),
    ('session-ack-health', 'pool', '    wait_ready(cfg, timeout=30)', '    pass', 'Sessions.test_session_ack_follows_health_once_and_requires_success'),
    ('session-ack-retry', 'pool', 'if not record.get("sessionReadyReported"):', 'if True:', 'Sessions.test_session_ack_follows_health_once_and_requires_success'),
    ('session-ack-result', 'pool', 'if status != 200:\n            raise Refused("pool_session_ack_refused")', 'if False:\n            raise Refused("pool_session_ack_refused")', 'Sessions.test_session_ack_follows_health_once_and_requires_success'),
    ('generation-replay', 'pool', 'claim["generation"] <= previous["claim"]["generation"]', 'False', 'Fences.test_generation_must_increase_independently_of_epoch'),
    ('epoch-replay', 'pool', 'claim["leaseEpoch"] <= previous["claim"]["leaseEpoch"]', 'False', 'Fences.test_durable_epoch_refuses_replay_and_second_tenant'),
    ('blank-authorization', 'pool', 'not claim.get("createVolume") or not fs_uuid', 'not fs_uuid', 'Devices.test_refuse_unformatted_disk_without_explicit_provision_fields'),
    ('blank-signature', 'pool', 'probe.returncode != 2 or probe.stdout.strip()', 'probe.returncode != 2', 'Devices.test_refuse_unformatted_disk_without_explicit_provision_fields'),
    ('blank-probe-result', 'pool', 'probe.returncode != 2 or probe.stdout.strip()', 'probe.stdout.strip()', 'Devices.test_refuse_unformatted_disk_without_explicit_provision_fields'),
    ('strict-json', 'pool', 'claim = leasemod.strict_json(raw)', 'claim = json.loads(raw)', 'Protocol.test_strict_claim_json_and_nonce_are_required'),
    ('counter-bound', 'pool', 'not 1 <= value <= 2147483647', 'not 1 <= value <= 2**53 - 1', 'Protocol.test_strict_claim_json_and_nonce_are_required'),
    ('mandatory-nonce', 'pool', '(field == "enrollNonce" and not require_nonce)', '(field == "enrollNonce")', 'Protocol.test_strict_claim_json_and_nonce_are_required'),
    ('request-deadline', 'pool', 'if remaining <= 0:', 'if False:', 'Protocol.test_request_timeout_never_exceeds_remaining_budget'),
    ('request-timeout', 'pool', 'timeout=min(20, remaining)', 'timeout=20', 'Protocol.test_request_timeout_never_exceeds_remaining_budget'),
    ('record-phase', 'pool', 'if record["phase"] not in ("reserved", "guarding", "enrolled", "switched", "failed"):', 'if False:', 'Resume.test_corrupt_resume_records_refuse'),
    ('record-instance', 'pool', 'if not isinstance(record["instanceId"], str) or not record["instanceId"]:', 'if False:', 'Resume.test_corrupt_resume_records_refuse'),
    ('record-lease-parser', 'pool', 'RecursionError, leasemod.LeaseError, Refused', 'RecursionError, Refused', 'Resume.test_corrupt_resume_records_refuse'),
    ('record-lease-binding', 'pool', 'any(saved[k] != record["claim"][k] for k in ("computerId", "generation", "leaseEpoch"))', 'False', 'Resume.test_corrupt_resume_records_refuse'),
    ('record-volume-binding', 'pool', 'saved["volumeId"].replace("-", "") != record["claim"]["volumeSerial"].replace("-", "")', 'False', 'Resume.test_corrupt_resume_records_refuse'),
    ('single-use-host', 'pool', '        raise Refused("pool_host_already_claimed")\n    instance_id', '        pass\n    instance_id', 'Fences.test_durable_epoch_refuses_replay_and_second_tenant'),
    ('identity-required', 'pool', 'if not instance_id:', 'if False:', 'Fences.test_instance_identity_is_required'),
    ('guard-lock', 'pool', 'fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)', 'pass', 'Resume.test_concurrent_guard_activation_refuses'),
    ('resume-pool-id', 'pool', 'record["poolHostId"] != pool_lease["poolHostId"]', 'False', 'Resume.test_resume_refuses_changed_pool_or_instance'),
    ('resume-pool-generation', 'pool', 'record["poolGeneration"] != pool_lease["poolGeneration"]', 'False', 'Resume.test_resume_refuses_changed_pool_or_instance'),
    ('resume-instance', 'pool', 'record["instanceId"] != guard.current_instance_id(cfg)', 'False', 'Resume.test_resume_refuses_changed_pool_or_instance'),
    ('settled-refusal', 'pool', 'if record["phase"] == "failed":', 'if False:', 'Lifecycle.test_enrollment_failure_unmounts_and_burns_host'),
    ('initial-disk-epoch', 'pool', 'allow_reboot=resumed_guard', 'allow_reboot=True', 'Lifecycle.test_claim_mount_enroll_and_switch_into_standard_chain'),
    ('resume-disk-epoch', 'pool', 'allow_reboot=resumed_guard', 'allow_reboot=False', 'Resume.test_crash_after_marker_commit_resumes_same_instance_epoch'),
    ('warm-stop-once', 'pool', 'if not stopped:\n            stop_attempted', 'if True:\n            stop_attempted', 'Resume.test_restart_after_switch_reuses_enrollment_and_does_not_stop_again'),
    ('session-phase', 'pool', 'record["phase"] != "switched" or any', 'False or any', 'Sessions.test_session_refuses_missing_or_mismatched_record'),
    ('session-epoch', 'pool', 'any(record["claim"][k] != lease.get(k)\n                for k in ("computerId", "generation", "leaseEpoch"))', 'False', 'Sessions.test_session_refuses_missing_or_mismatched_record'),
    ('session-required', 'pool', 'if session_record(cfg, lease) is None:\n        raise Refused("pool_session_missing")', 'if False:\n        raise Refused("pool_session_missing")', 'Sessions.test_session_refuses_missing_or_mismatched_record'),
    ('single-desktop-start', 'pool', 'if desktop.state(cfg) != "running":\n        relay', 'if True:\n        relay', 'Sessions.test_single_restart_with_relay_and_user_disk_before_ready'),
    ('relay-before-start', 'pool', 'if relay is None:', 'if False:', 'Sessions.test_missing_relay_refuses_before_start'),
    ('desktop-start-result', 'pool', '        if desktop.run(cfg, detach=True, log=os.path.join(cfg.runDir, "desktop.log")) != 0:', '        if desktop.run(cfg, detach=True, log=os.path.join(cfg.runDir, "desktop.log")) < 0:', 'Sessions.test_failed_start_never_reports_healthy'),
    ('applied-relay', 'pool', 'if desktop.read_ice_state(cfg) != "applied":', 'if False:', 'Sessions.test_running_desktop_without_applied_relay_refuses'),
    ('readiness-record', 'pool', 'if session_record(cfg, lease) is None:\n            return False', 'if False:\n            return False', 'Sessions.test_session_refuses_missing_or_mismatched_record'),
    ('readiness-disk', 'pool', '        guard.require_stamp(cfg, lease)\n        return desktop.read_ice_state', '        pass\n        return desktop.read_ice_state', 'Sessions.test_session_status_waits_for_health_relay_and_guard'),
    ('readiness-ice', 'pool', 'desktop.read_ice_state(cfg) == "applied" and health(cfg)["ok"]', 'health(cfg)["ok"]', 'Sessions.test_session_status_waits_for_health_relay_and_guard'),
    ('readiness-editor', 'pool', 'desktop.read_ice_state(cfg) == "applied" and health(cfg)["ok"]', 'desktop.read_ice_state(cfg) == "applied"', 'Sessions.test_session_status_waits_for_health_relay_and_guard'),
    ('status-fresh-relay', 'agent', 'c is not None and pool.session_ready(self.cfg, self.lease)', 'pool.session_ready(self.cfg, self.lease)', 'Sessions.test_session_status_waits_for_health_relay_and_guard'),
    ('status-ready-gate', 'agent', 'if result["desktop"] == "running" and not result["sessionReady"]:', 'if False:', 'Sessions.test_session_status_waits_for_health_relay_and_guard'),
    ('guard-resume-routing', 'cli', 'if record is not None and lease.get("kind") != "pool":', 'if False:', 'Resume.test_guard_restart_with_computer_lease_checks_instance'),
    ('nonce-enrollment', 'enroll', 'if lease.get("nonceConsumed") or not lease.get("nonce"):', 'if lease.get("nonceConsumed"):', 'Protocol.test_enrollment_without_nonce_is_refused'),
    ('no-secret-error', 'enroll', 'raise Refused("enroll_refused", f"HTTP {status}")', 'raise Refused("enroll_refused", f"HTTP {status}: {resp!r}")', 'Resume.test_failure_body_and_nonce_never_reach_logs'),
]


def main():
    host = Path(__file__).resolve().parents[1]
    failed = []
    with tempfile.TemporaryDirectory(prefix='ezil-pool-mutations-') as scratch:
        root = Path(scratch)
        shutil.copytree(host / 'lib', root / 'lib', ignore=shutil.ignore_patterns('__pycache__'))
        (root / 'test').mkdir()
        for name in ('test_pool.py', 'test_ice.py', 'stub_servers.py'):
            shutil.copyfile(host / 'test' / name, root / 'test' / name)
        for name, module, before, after, test in MUTATIONS:
            path = root / 'lib' / 'ezil_host' / (module + '.py')
            original = path.read_text()
            if before not in original:
                raise RuntimeError('mutation anchor missing: ' + name)
            mutated = original.replace(before, after, 1)
            compile(mutated, str(path), 'exec')
            path.write_text(mutated)
            try:
                result = subprocess.run([sys.executable, '-B', '-m', 'unittest', '-q', 'test_pool.' + test],
                                        cwd=root / 'test', capture_output=True, text=True, timeout=15,
                                        env={**os.environ, 'PYTHONDONTWRITEBYTECODE': '1'})
                killed = result.returncode != 0 and 'FAILED (' in result.stderr and 'ImportError' not in result.stderr
                print(('KILLED ' if killed else 'SURVIVED ') + name, flush=True)
                if not killed:
                    failed.append(name)
                    print(result.stderr, flush=True)
            finally:
                path.write_text(original)
    print(f'Pool mutations: {len(MUTATIONS) - len(failed)} killed, {len(failed)} survived', flush=True)
    return bool(failed)


if __name__ == '__main__':
    sys.exit(main())
