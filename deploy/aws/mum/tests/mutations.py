#!/usr/bin/env python3
"""Offline mutation checks for release guards; restore every edit in finally.

Run separately from run.sh: python3 -B deploy/aws/mum/tests/mutations.py
Mutations disable need() predicates, generated guards, or state transitions,
then require their focused regression to fail. No cloud calls escape the existing synthetic harness.
"""
import ast
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
INTEGRATION = 'IntegrationTests.'
CASES = {
    'rebase_manifest.py': {
        'deployed release is not the promoted app tuple': 'test_wrong_deployed_refused_at_plan_cloud_app_and_first_promotion',
        'image predecessor is not retained in live registry': 'test_predecessor_must_be_retained_and_match_both_bake_fields',
        'rebase target requires a previous lower': 'test_maintenance_promotion_and_invalid_target_lineage_still_refuse',
        'invalid previous lower digest': 'test_maintenance_promotion_and_invalid_target_lineage_still_refuse',
    },
    'json-tool.py': {
        'resolved SSM parameter changed': 'BaseImageTests.test_without_flag',
        'reviewed base AMI does not match resolved value': 'BaseImageTests.test_flag_mismatch',
        'extra parameter change in change set': 'BaseImageTests.test_path_changed',
        'invalid reviewed base AMI identity': 'BaseImageTests.test_image_identity',
        'invalid live base AMI ID': 'BaseImageTests.test_live_identity',
        'reviewed base image response mismatch': 'BaseImageTests.test_response',
        'reviewed base image owner is not Canonical': 'BaseImageTests.test_owner',
        'reviewed base image name mismatch': 'BaseImageTests.test_name',
        'reviewed base image is not available': 'BaseImageTests.test_state',
        'reviewed base image architecture mismatch': 'BaseImageTests.test_architecture',
        'invalid base image creation date': 'BaseImageTests.test_date_valid',
        'reviewed base image is not newer': 'BaseImageTests.test_date_newer',
        'duplicate release pair': 'RegistryTests.test_registry_rejects_foreign_duplicate_or_ambiguous_target',
        'immutable release pair rewrite refused': 'RegistryTests.test_legacy_null_fields_cannot_be_rewritten_in_place',
        'release registry full; retained placement/job evidence must never be dropped': 'RegistryTests.test_registry_full_refuses_without_dropping_any_record',
    },
    'rebase_release.py': {
        'invalid staged change set identity': 'test_null_change_set_refused_outside_identity',
        'beforeParameters requires unchanged identity': 'test_unchanged_identity_parameter_snapshot_guards',
        'invalid unchanged identity evidence': 'test_unchanged_identity_tampered_receipt_refused',
        'invalid cloud completion evidence': 'test_unchanged_identity_tampered_receipt_refused',
        'remote command not terminal; wait or cancel': 'test_reconcile_inprogress_install_then_completes',
        'secret written; app not yet adopted — resume the same operation': 'test_secret_written_stale_app_reconcile_refuses_same_plan_resumes',
        'running app deployment mismatch': 'test_local_running_deployment_receipt_guard',
        'invalid ledger state': 'test_new_ledger_schema_guards',
        'invalid pending snapshots': 'test_new_ledger_schema_guards',
        'unresolved pending ledger entry': 'test_new_ledger_schema_guards',
        'terminal ledger entry requires pending': 'test_new_ledger_schema_guards',
        'pending operation of another plan; run ledger-reconcile': 'test_pending_apply_completion_failure_fences_legacy_and_reconciles',
        'pending operation differs; run ledger-reconcile': 'test_pending_apply_completion_failure_fences_legacy_and_reconciles',
        'ledger inputs changed during readback': 'test_pending_expected_guard_and_readback_guards',
        'ledger app readback missing': 'test_pending_expected_guard_and_readback_guards',
        'pending operation expected state changed': 'test_pending_expected_guard_and_readback_guards',
        'pending operation; run ledger-reconcile before planning': 'test_pending_apply_completion_failure_fences_legacy_and_reconciles',
        'ledger-reconcile requires this plan pending entry': 'test_reconcile_requires_pending_and_matching_promotion_journal',
        'manual reconciliation required': 'test_reconcile_neither_state_refuses_nonsecret_diff_and_retry_drift',
        'reconciliation journal belongs to another plan': 'test_reconcile_requires_pending_and_matching_promotion_journal',
        'ledger-reconcile requires --plan': 'test_reconcile_cli_requires_plan',
        'foundation launch data changed outside AMI': 'test_non_ami_launch_template_difference_refuses',
        'installed app commit mismatch': 'test_ssm_installed_sha_must_match_plan',
        'unreviewed schema path': 'test_schema_path_pin_is_not_relaxed',
        'maintenance previous must be null': 'test_maintenance_promotion_and_invalid_target_lineage_still_refuse',
        'maintenance source lower/new agent mismatch': 'test_maintenance_promotion_and_invalid_target_lineage_still_refuse',
        'image predecessor and bake disagree': 'test_predecessor_must_be_retained_and_match_both_bake_fields',
        'invalid promotion ledger': 'test_ledger_schema_and_entry_guards',
        'empty promotion ledger; use ledger-init': 'test_ledger_schema_and_entry_guards',
        'invalid ledger entry': 'test_ledger_schema_and_entry_guards',
        'invalid ledger generation': 'test_ledger_schema_and_entry_guards',
        'invalid ledger source pin': 'test_ledger_schema_and_entry_guards',
        'invalid ledger operation/version': 'test_ledger_schema_and_entry_guards',
        'invalid ledger tuple': 'test_ledger_schema_and_entry_guards',
        'invalid ledger registry hash': 'test_pending_registry_drift_and_hash_schema_refused',
        'ledger drift': 'test_ledger_tuple_and_registry_drift_refuse_all_app_operations',
        'stale plan: latest ledger entry belongs to another plan': 'test_stale_105_all_app_operations_after_106_apply_promote_and_rollback',
        'stale plan: ledger generation advanced': 'test_first_operation_generation_pin_refuses_even_when_tuple_unchanged',
        'rollback requires a ledger promotion': 'test_rollback_requires_own_ledger_promotion',
        'release already rolled back': 'test_double_rollback_refused_before_app_or_secret_mutation',
        'invalid running app gitSha': 'test_ledger_schema_and_entry_guards',
        'plan changed before ledger append': 'test_ledger_append_rechecks_plan_and_ledger_before_atomic_write',
        'ledger changed during operation': 'test_ledger_append_rechecks_plan_and_ledger_before_atomic_write',
        'invalid ledger generation pin': 'test_both_artifact_hashes_are_pinned_and_generation_is_strict',
        'plan evidence fields mismatch': 'test_both_artifact_hashes_are_pinned_and_generation_is_strict',
        'app verification missing': 'test_dry_run_and_failed_app_verification_do_not_append_ledger',
        'ledger-init requires this plan promoted journal': 'test_ledger_init_dry_run_exists_tuple_and_journal_status_guards',
        'ledger-init journal target mismatch': 'test_ledger_init_dry_run_exists_tuple_and_journal_status_guards',
        'promotion ledger already exists': 'test_ledger_init_dry_run_exists_tuple_and_journal_status_guards',
        'ledger-init live tuple mismatch': 'test_ledger_init_dry_run_exists_tuple_and_journal_status_guards',
        'ledger-init inputs changed during readback': 'test_ledger_init_dry_run_exists_tuple_and_journal_status_guards',
        'maintenance releases are source artifacts; do not authorize a rebase target': 'test_maintenance_promotion_and_invalid_target_lineage_still_refuse',
    },
    'rebase_ssm.py': {
        'incomplete SSM reconciliation': 'IntegrationTests.test_reconcile_lost_submission_found_requires_terminal',
        'uncertain SSM submission; reconcile command before retry': 'SsmTests.test_ambiguous_missing_command_never_retries',
    },
    'rebase_cloudformation.py': {
        'invalid pool IAM review': 'PoolIamTests.test_pool_artifact_schema_and_namespace',
        'pool IAM namespace mismatch': 'PoolIamTests.test_pool_artifact_schema_and_namespace',
        'pool IAM Allow requires managed-by and stage resource conditions': 'PoolIamTests.test_pool_allow_requires_both_resource_tag_conditions',
        'pool IAM RunInstances type Deny required': 'PoolIamTests.test_pool_type_deny_required',
        'pool IAM RunInstances type Deny removal refused': 'PoolIamIncrementalTests.test_incremental_type_deny_removal_refused',
        'pool IAM statement delta differs from review': 'PoolIamTests.test_pool_artifact_must_match_every_statement',
        'pool IAM deny removal exceeds shared boundary allowance': 'PoolIamTests.test_pool_other_deny_removals_refused',
        'pool IAM boundary requires matching conditioned Allow': 'PoolIamTests.test_pool_boundary_matching_allow_required',
        'reviewed pool IAM artifact changed': 'PoolIamTests.test_pool_pin_verify_and_execute',
        'unexpected resource replacement': 'CloudFormationTests.test_dynamic_lambda_dependents_execute_and_replacement_guard',
        'unexplained property recreation': 'CloudFormationTests.test_dynamic_lambda_dependents_execute_cause_guards',
        'unexplained Lambda ARN dependency': 'CloudFormationTests.test_dynamic_lambda_dependents_execute_cause_guards',
        'change-set action/type mismatch': 'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views',
        'change-set property details differ from exact review': 'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views',
        'change-set scope mismatch': 'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views',
        'change-set omits reviewed changes': 'CloudFormationTests.test_dynamic_dependents_omission_guards',
        'review does not exactly enumerate template changes': 'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes',
        'null change set is only allowed for identity': 'test_null_change_set_refused_outside_identity',
        'unchanged identity requires equal reviewed templates': 'test_unchanged_identity_unequal_templates_refused',
        'unchanged identity review must show no changes': 'test_unchanged_identity_nonempty_review_refused',
        'invalid identity parameter snapshot': 'test_unchanged_identity_parameter_snapshot_guards',
        'duplicate identity parameter keys': 'test_unchanged_identity_parameter_snapshot_guards',
        'identity stack drifted from the reviewed template': 'test_unchanged_identity_live_drift_refuses',
        'one unchanged identity stack required': 'test_unchanged_identity_stack_count_role_and_gate_guards',
        'identity stack must be stable COMPLETE without rollback': 'test_unchanged_identity_unstable_or_rollback_refused',
        'unchanged identity execution role drift': 'test_unchanged_identity_stack_count_role_and_gate_guards',
        'identity stack parameters drifted from the review': 'test_unchanged_identity_parameter_drift_refused',
    },
}


EXPLICIT = [
    ('json-tool.py', 'key == "UbuntuAmiId" and reviewed_base_ami', 'reviewed_base_ami',
     'BaseImageTests.test_other_ssm', 'review exception restricted to UbuntuAmiId'),
    ('json-tool.py', 'if reviewed_base_change and logical == recipe and name == "ParentImage":',
     'if logical == recipe and name == "ParentImage":',
     'BaseImageTests.test_parent_details', 'ParentImage detail requires a validated base change'),
    ('json-tool.py', 'return (source == "ParameterReference" and cause == "UbuntuAmiId") or (source == "DirectModification" and cause == "")', 'return True',
     'BaseImageTests.test_parent_details', 'ParentImage detail requires Ubuntu parameter cause'),
    ('json-tool.py', 'or (source == "DirectModification" and cause == "")', 'or (source == "DirectModification")',
     'BaseImageTests.test_live_parent_shape', 'live ParentImage shape requires no causing entity'),
    ('json-tool.py', 'creation_date(candidate) > creation_date(previous)', 'creation_date(candidate) >= creation_date(previous)',
     'BaseImageTests.test_date_newer', 'base image date must be strictly newer'),
    ('rebase_cloudformation.py', 'action.casefold() for action in', 'action for action in',
     'PoolIamTests.test_pool_action_case_normalization', 'IAM action_set case folding'),
    ('rebase_cloudformation.py', 'v.casefold() if isinstance(v,str)', 'v if isinstance(v,str)',
     'PoolIamTests.test_pool_action_case_normalization', 'scalar IAM action case folding'),
    ('rebase_cloudformation.py', 'sorted(a.casefold() for a in v)', 'sorted(v)',
     'PoolIamTests.test_pool_action_case_normalization', 'IAM action list case folding'),
    ('rebase_cloudformation.py', 'key.casefold():value', 'key:value',
     'PoolIamTests.test_pool_mixed_case_condition_keys_accepted', 'IAM resource condition key case folding'),
    ('rebase_cloudformation.py', "equals.get(prefix+'/ezil:'+tag)==value", "str(equals.get(prefix+'/ezil:'+tag)).casefold()==value",
     'PoolIamTests.test_pool_tag_values_remain_case_sensitive', 'IAM resource tag value case sensitivity'),
    ('rebase_cloudformation.py', 'logical==SHARED_BOUNDARY', "logical.startswith('Boundary')",
     'PoolIamTests.test_pool_second_boundary_is_not_shared', 'shared boundary exact logical ID'),
    ('rebase_cloudformation.py', "and resource['Type']=='AWS::IAM::ManagedPolicy'", '',
     'PoolIamTests.test_pool_shared_boundary_resource_type_required', 'shared boundary resource type'),
    ('rebase_cloudformation.py', 'logical==POOL_CONTROLLER', "logical.startswith('LifecycleControllerRoleDefaultPolicy')",
     'PoolIamTests.test_pool_controller_exact_id_and_type_required', 'controller exact logical ID'),
    ('rebase_cloudformation.py', "and (phase!='workflows' or after['Resources'].get(POOL_CONTROLLER,{}).get('Type')=='AWS::IAM::Policy')", '',
     'PoolIamTests.test_pool_controller_exact_id_and_type_required', 'controller resource type'),
    ('rebase_cloudformation.py', "or phase=='identity' and not review['stacks']['identity']\n", 'or False\n',
     'PoolIamIncrementalTests.test_real_incremental_delta_accepted', 'identity defers workflows Deny presence'),
    ('rebase_cloudformation.py', "or phase=='identity' and not review['stacks']['identity']\n", "or phase=='identity'\n",
     'PoolIamIncrementalTests.test_incremental_identity_change_requires_enable_review', 'identity deferral only with an empty identity delta'),
    ('rebase_cloudformation.py', "or phase=='workflows' and any(statement_key(s)==type_deny", 'or False and any(statement_key(s)==type_deny',
     'PoolIamIncrementalTests.test_real_incremental_delta_accepted', 'incremental workflows accepts retained Deny'),
    ('rebase_cloudformation.py', "or phase=='workflows' and any(statement_key(s)==type_deny", 'or any(statement_key(s)==type_deny',
     'PoolIamIncrementalTests.test_incremental_identity_change_requires_enable_review', 'retained Deny exception limited to workflows'),
    ('rebase_cloudformation.py', "or phase not in ('identity','workflows')", "or phase not in ('identity','workflows','foundation')",
     'PoolIamIncrementalTests.test_incremental_presence_exception_only_identity_and_workflows', 'foundation gains no Deny requirement'),
    ('rebase_cloudformation.py', "or phase not in ('identity','workflows')", "or phase not in ('identity','workflows') and False",
     'PoolIamIncrementalTests.test_incremental_presence_exception_only_identity_and_workflows', 'other phases skip the Deny requirement'),
    ('rebase_cloudformation.py', "controller=after['Resources'].get(POOL_CONTROLLER,{})", "controller=before['Resources'].get(POOL_CONTROLLER,{})",
     'PoolIamIncrementalTests.test_incremental_after_type_deny_required', 'retained Deny must be in AFTER controller'),
    ('rebase_cloudformation.py', 'any(statement_key(s)==type_deny for s in statements(', 'any(True for s in statements(',
     'PoolIamIncrementalTests.test_incremental_after_type_deny_required', 'retained Deny must match exact statement'),
    ('rebase_cloudformation.py', "controller.get('Properties',{}).get('PolicyDocument',{}).get('Statement',[])", 'controller',
     'PoolIamIncrementalTests.test_incremental_after_type_deny_required', 'retained Deny must be an effective policy statement'),
    ('rebase_cloudformation.py', "for delta in review['stacks']['workflows'].values()\n                 for s in delta['removed']",
     "for delta in [review['stacks']['workflows'].get(POOL_CONTROLLER,{'removed':[]})]\n                 for s in delta['removed']",
     'PoolIamIncrementalTests.test_incremental_type_deny_removal_refused', 'type Deny removal forbidden in every workflows policy'),
    ('rebase_cloudformation.py', "sorted(canonical_iam(delta[name]),key=statement_key)", "sorted(delta[name],key=statement_key)",
     'PoolIamTests.test_pool_review_action_case_ignored', 'artifact delta case folding'),
    ('rebase_cloudformation.py', "'ec2:deletevolume','ec2:deletesnapshot'", "'ec2:DeleteVolume','ec2:deletesnapshot'",
     'PoolIamTests.test_pool_mixed_case_unconditioned_actions_refused', 'forbidden action case folding'),
    ('rebase_cloudformation.py', "{'kms:generatedatakey*','kms:reencrypt*'}", "{'kms:GenerateDataKey*','kms:ReEncrypt*'}",
     'PoolIamTests.test_pool_mixed_case_kms_wildcards', 'KMS wildcard case folding'),
    ('rebase_cloudformation.py', ' and action_set(value)^action_set(old)==POOL_ACTIONS', '',
     'PoolIamTests.test_pool_shared_boundary_has_no_other_allow_changes', 'pool boundary exception is exactly two actions'),
    ('rebase_cloudformation.py', "if logical not in review['changes'] or raw_old.get(logical)==raw_new.get(logical):continue", 'continue',
     'PoolIamTests.test_pool_provider_can_review_exact_reordered_property', 'provider can enumerate the exact reordered IAM property'),
    ('rebase_cloudformation.py', "canonical_iam(resource) if resource['Type'].startswith('AWS::IAM::') else resource", 'canonical_iam(resource)',
     'PoolIamTests.test_pool_action_normalization_does_not_hide_non_iam_changes', 'Action normalization limited to IAM resources'),
    ('rebase_cloudformation.py', "k in ('Action','NotAction') and 'Effect' in value", 'False',
     'PoolIamTests.test_pool_action_reorder_is_unchanged', 'IAM Action order normalization'),
    ('rebase_cloudformation.py', "POOL_ACTIONS | {'ec2:terminateinstances'}", 'POOL_ACTIONS',
     'PoolIamTests.test_pool_allow_requires_both_resource_tag_conditions', 'pool termination conditions'),
    ('rebase_cloudformation.py', '(FORBIDDEN-reviewed_pool_actions)', 'set()',
     'PoolIamTests.test_pool_does_not_bypass_other_guards', 'pool preserves other forbidden grants'),
    ('rebase_cloudformation.py', 'pool_iam=load_pool_iam(pool_iam,digest)', 'pool_iam=None',
     'PoolIamTests.test_pool_pin_verify_and_execute', 'execute consumes pinned pool review'),
    ('rebase_release.py', 'pool_iam=plan[\'rollout\']', 'pool_iam=None',
     'IntegrationTests.test_pool_rollout_reaches_cloud_with_pinned_artifact', 'cloud operation carries pinned pool review'),
    ('rebase_cloudformation.py', '\n        validate_change_details(phase,r,expected,resource,lambda_arns)\n',
     '\n        pass\n',
     'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views', 'shared detail guards in property-values view'),
    ('rebase_cloudformation.py', '\n                validate_change_details(phase,r,expected,resource,lambda_arns)\n',
     '\n                pass\n',
     'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views', 'shared detail guards in plain view'),
    ('rebase_cloudformation.py', "detail.get('Evaluation')=='Dynamic' and detail.get('ChangeSource')=='ResourceAttribute'",
     "detail.get('ChangeSource')=='ResourceAttribute'",
     'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views', 'dependent detail Dynamic evaluation'),
    ('rebase_cloudformation.py', "detail.get('Evaluation')=='Dynamic' and detail.get('ChangeSource')=='ResourceAttribute'",
     "detail.get('Evaluation')=='Dynamic'",
     'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views', 'dependent detail ResourceAttribute source'),
    ('rebase_cloudformation.py', "and detail.get('CausingEntity') in lambda_arns", 'and True',
     'CloudFormationTests.test_dynamic_dependents_detail_guards_in_both_views', 'dependent detail reviewed Lambda ARN'),
    ('rebase_cloudformation.py', 'if not resource or old.get(logical)!=resource:return set()',
     'if not resource:return set()',
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent resource template unchanged'),
    ('rebase_cloudformation.py', "elif kind=='AWS::Lambda::Permission':", "elif kind in ('AWS::Lambda::Permission','AWS::IAM::Role'):",
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent resource type allowlist'),
    ('rebase_cloudformation.py', "if entry!={'action':'Modify','properties':[property_name],'attributes':[]}:return set()",
     "if entry['action']!='Modify' or entry['properties']!=[property_name]:return set()",
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent review empty attributes'),
    ('rebase_cloudformation.py', "if entry!={'action':'Modify','properties':[property_name],'attributes':[]}:return set()",
     "if entry['properties']!=[property_name] or entry['attributes']:return set()",
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent review Modify action'),
    ('rebase_cloudformation.py', "if entry!={'action':'Modify','properties':[property_name],'attributes':[]}:return set()",
     "if entry['action']!='Modify' or entry['attributes']:return set()",
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent review exact property list'),
    ('rebase_cloudformation.py', "if not isinstance(value,dict) or set(value)!={'Fn::GetAtt'}:continue",
     "if not isinstance(value,dict) or 'Fn::GetAtt' not in value:continue",
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent exact GetAtt expression'),
    ('rebase_cloudformation.py', " or ref[1]!='Arn'", '',
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent GetAtt ARN attribute'),
    ('rebase_cloudformation.py', "new.get(source,{}).get('Type')=='AWS::Lambda::Function'", 'True',
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent source Lambda type'),
    ('rebase_cloudformation.py', "and actual.get(source,{}).get('action')=='Modify'):", 'and True):',
     'CloudFormationTests.test_dynamic_lambda_dependents_refuse_unrelated_changes', 'dependent source modified in actual diff'),
    ('rebase_release.py', "('tuple', 'registrySha256', 'appGitSha')", "('registrySha256', 'appGitSha')",
     'IntegrationTests.test_ledger_tuple_and_registry_drift_refuse_all_app_operations', 'release projection tuple drift'),
    ('rebase_release.py', "('tuple', 'registrySha256', 'appGitSha')", "('tuple', 'appGitSha')",
     'IntegrationTests.test_ledger_tuple_and_registry_drift_refuse_all_app_operations', 'release projection registry drift'),
    ('rebase_release.py', "('tuple', 'registrySha256', 'appGitSha')", "('tuple', 'registrySha256')",
     'IntegrationTests.test_ledger_running_sha_drift_refuses', 'release projection observed SHA drift'),
    ('rebase_release.py', "('tuple', 'registrySha256', 'appGitSha')", "('tuple', 'registrySha256', 'appGitSha', 'secretVersionId')",
     'IntegrationTests.test_gate_toggle_admits_rollback', 'release projection excludes secret version evidence'),
    ('rebase_release.py', "if k in expected and (k != 'appGitSha' or observed['appGitSha'] is not None)",
     "if k != 'appGitSha' or observed['appGitSha'] is not None",
     'IntegrationTests.test_legacy_ledger_projection_and_registry_hash', 'legacy registry hash optional'),
    ('rebase_release.py', "d.get('releases', [])", '[]',
     'IntegrationTests.test_legacy_ledger_projection_and_registry_hash', 'registry hash records exact registry'),
    ('rebase_release.py', "json.dumps(d.get('releases', []), sort_keys=True, separators=(',', ':'))",
     "json.dumps(d.get('releases', []), separators=(',', ':'))",
     'IntegrationTests.test_legacy_ledger_projection_and_registry_hash', 'registry hash canonical object ordering'),
    ('rebase_release.py', "expected = release_state(expected_d, plan['rollout']['app']['gitSha'])",
     "expected = {k:v for k,v in release_state(expected_d, plan['rollout']['app']['gitSha']).items() if k!='registrySha256'}",
     'IntegrationTests.test_legacy_ledger_projection_and_registry_hash', 'pending expected registry hash'),
    ('rebase_release.py', "'before': observed_state(envelope, d, result['gitSha']), 'expected': expected",
     "'before': {k:v for k,v in observed_state(envelope, d, result['gitSha']).items() if k!='registrySha256'}, 'expected': expected",
     'IntegrationTests.test_legacy_ledger_projection_and_registry_hash', 'pending before registry hash'),
    ('rebase_release.py', '**observed_state(envelope, d, git_sha)}',
     "**{k:v for k,v in observed_state(envelope, d, git_sha).items() if k!='registrySha256'}}",
     'IntegrationTests.test_legacy_ledger_projection_and_registry_hash', 'completed registry hash'),
    ('rebase_release.py', "                          'identity stack drifted from the reviewed template',\n", '',
     'IntegrationTests.test_unchanged_identity_real_cli_live_readback', 'public identity drift refusal'),
    ('rebase_release.py', 'expected_deployment = rebase_app.public_deployment(d)',
     "expected_deployment = rebase_app.public_deployment({**d, **pending['expected']['tuple']})",
     'IntegrationTests.test_legacy_105_rollback_completion_failure_reconciles', 'legacy reconciliation preserves absent tuple fields'),
    ('rebase_app.py', 'install_script=install_script.replace(anchor,guard+anchor)',
     'install_script=install_script.replace(anchor,anchor)',
     'AppPayloadTests.test_checksum_marker_guard_executes_and_refuses_mismatch', 'remote checksum-marker guard'),
    ('rebase_app.py', "if EXPECTED is not None and result['deployment']!=EXPECTED: raise RuntimeError()", 'if False: raise RuntimeError()',
     'AppPayloadTests.test_remote_deployment_guard_executes_for_install_and_gate', 'remote deployment equality guard'),
    ('rebase_ssm.py', "if invocation['Status'] not in terminal:", 'if False:',
     'IntegrationTests.test_reconcile_inprogress_install_then_completes', 'invocation terminal guard'),
    ('rebase_ssm.py', "if records[0]['Status'] not in terminal:", 'if False:',
     'IntegrationTests.test_reconcile_inprogress_install_then_completes', 'parent command terminal guard'),
    ('rebase_ssm.py', "commands = list(state['attempts'])", 'commands = []',
     'IntegrationTests.test_reconcile_all_generation_journals_and_retry_ids', 'all historical transport attempts'),
    ('rebase_ssm.py', "for path in sorted(Path(directory).glob('*-ssm.json')):", "for path in sorted(p for p in Path(directory).glob('*-ssm.json') if '-verify-' not in p.name):",
     'IntegrationTests.test_reconcile_all_generation_journals_and_retry_ids', 'all generation transport journals'),
    ('rebase_ssm.py', "elif state['status'] != 'uploading':", 'elif False:',
     'IntegrationTests.test_reconcile_lost_submission_absence_is_not_proof', 'lost submission keeps fence'),
    ('rebase_ssm.py', "if response.get('NextToken') or len(records) != 1 or records[0]['CommandId'] != command_id:", 'if False:',
     'IntegrationTests.test_reconcile_status_read_errors_keep_fence', 'complete command status readback'),
    ('rebase_ssm.py', 'except Exception:\n        # Keep provider details (including remote stdout) out of diagnostics.\n        return False',
     'except Exception:\n        return True',
     'IntegrationTests.test_reconcile_status_read_errors_keep_fence', 'unreadable status keeps fence'),
    ('rebase_release.py', "'ledgerGeneration' not in plan and legacy_path.exists()", 'legacy_path.exists()',
     'IntegrationTests.test_new_plan_never_imports_unsuffixed_transport', 'legacy journal isolation'),
    ('rebase_app.py', "if INSTALL and result['gitSha']!=APP['gitSha']: raise RuntimeError()", 'if False: raise RuntimeError()',
     'AppPayloadTests.test_remote_installed_sha_guard_executes', 'remote installed-SHA guard'),
    ('rebase_release.py', "operation += '-g' + str(generation)", 'operation += ""',
     'IntegrationTests.test_apply_retry_after_promote_and_rollback_uses_distinct_journals', 'generation transport key'),
    ('rebase_release.py', 'ledger = write_ledger_entry(ledger_path, ledger, path, plan, entry)', 'ledger = ledger',
     'IntegrationTests.test_pending_write_failure_prevents_install_and_secret_put', 'durable intent before mutation'),
    ('rebase_release.py', "if e.get('state', 'completed') == 'completed'", "if e.get('state', 'completed') != 'pending'",
     'IntegrationTests.test_pending_crash_aborts_and_retry_gets_new_generation', 'aborted entries do not advance admission'),
    ('rebase_release.py', "ledger_drift(ledger, envelope, d, result['gitSha'])", 'ledger_drift(ledger, envelope, d)',
     'IntegrationTests.test_reconcile_neither_state_refuses_nonsecret_diff_and_retry_drift', 'running SHA drift'),
]


def run_test(test, env):
    suite = 'base-ami.py' if test.startswith('BaseImageTests.') else 'rollout.py'
    return subprocess.run([sys.executable, '-B', str(HERE / suite), test],
                          env=env, capture_output=True, text=True, timeout=60)


def main():
    killed = total = 0
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
    for name, cases in CASES.items():
        path = HERE.parent / name
        original = path.read_text()
        offsets = [0]
        for line in original.splitlines(keepends=True):
            offsets.append(offsets[-1] + len(line))
        found = set()
        for node in ast.walk(ast.parse(original)):
            if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == 'need'
                    and len(node.args) == 2 and isinstance(node.args[1], ast.Constant)):
                continue
            message = node.args[1].value
            if message not in cases:
                continue
            found.add(message)
            predicate = node.args[0]
            start = offsets[predicate.lineno - 1] + predicate.col_offset
            end = offsets[predicate.end_lineno - 1] + predicate.end_col_offset
            test = cases[message]
            if '.' not in test:
                test = INTEGRATION + test
            total += 1
            try:
                path.write_text(original[:start] + 'True' + original[end:])
                result = run_test(test, env)
                failed = result.returncode != 0 and 'FAILED (' in result.stderr
                killed += failed
                print(f'{"KILLED" if failed else "SURVIVED"} {name}:{node.lineno} {message}', flush=True)
                if not failed:
                    print(result.stdout + result.stderr, flush=True)
            finally:
                path.write_text(original)
        if found != cases.keys():
            raise ValueError('Missing guard selectors: ' + repr(cases.keys() - found))
    for name, old, new, test, label in EXPLICIT:
        path = HERE.parent / name
        original = path.read_text()
        if original.count(old) != 1:
            raise ValueError('Nonunique explicit mutation: ' + label)
        total += 1
        try:
            path.write_text(original.replace(old, new))
            result = run_test(test, env)
            failed = result.returncode != 0 and 'FAILED (' in result.stderr
            killed += failed
            print(f'{"KILLED" if failed else "SURVIVED"} {name} {label}', flush=True)
            if not failed:
                print(result.stdout + result.stderr, flush=True)
        finally:
            path.write_text(original)
    print(f'MUTATIONS: {killed}/{total} killed; all source restored', flush=True)
    return 0 if killed == total else 1


if __name__ == '__main__':
    sys.exit(main())
