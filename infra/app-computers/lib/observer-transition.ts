import { RemovalPolicy, Stack, aws_iam as iam, aws_lambda as lambda } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { PATH_METADATA_ENABLE_CONTEXT } from 'aws-cdk-lib/cx-api';

/** Exact previous observer version logical ids (`<Construct>ObserverCurrentVersion<8 hex><32 hex>`), one per workflow. */
export type TransitionObserverVersions = { lifecycle?: string; preparation?: string; recovery?: string };
/** Exact previous state-machine VERSION ARNs (same machine, earlier version), one per workflow: the still-deployed
 * versions whose execution histories must stay readable (history-key encryption context) through the promotion window. */
export type TransitionStateMachineVersions = { lifecycle?: string; preparation?: string; recovery?: string };
const LOGICAL_ID = /^[A-Za-z0-9]+ObserverCurrentVersion[0-9A-F]{8}[a-f0-9]{32}$/;
const VERSION_ARN = /^arn:aws:states:[a-z0-9-]+:\d{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$/;

/** `[previous]` when it is an earlier version of exactly `current`'s state machine; `[]` when absent; never anything else. */
export function priorVersion(current: string, previous: string | undefined): string[] {
    if (previous === undefined) return [];
    const machine = (arn: string) => arn.slice(0, arn.lastIndexOf(':')), number = (arn: string) => Number(arn.slice(arn.lastIndexOf(':') + 1));
    if (!VERSION_ARN.test(previous) || !VERSION_ARN.test(current) || machine(previous) !== machine(current) || number(previous) >= number(current))
        throw new Error('invalid_transition_state_machine_version');
    return [previous];
}

/**
 * Promotion window grant (staging incident 2026-11-17): the workflows change set lands before the app
 * promotes the new state-machine version, so the still-deployed previous version keeps invoking its
 * own immutable observer Lambda version. Keep that exact previous version resource (same logical id,
 * hence the same physical version) and allow the execution role to invoke it alongside the current one.
 * No wildcards: the only admitted resources are the two exact version Refs. The next rollout names the
 * then-previous version instead, and the older one is removed under its Retain policy.
 */
export function transitionObserverGrant(scope: Construct, observer: lambda.Function, previousLogicalId: string, role: iam.IRole): lambda.CfnVersion {
    const current = observer.currentVersion.node.defaultChild as lambda.CfnVersion;
    const currentId = Stack.of(scope).resolve(current.logicalId) as string;
    // Same construct (the 8-hex construct hash) but a different published version (the 32-hex asset hash).
    if (!LOGICAL_ID.test(previousLogicalId) || previousLogicalId.slice(0, -32) !== currentId.slice(0, -32) || previousLogicalId === currentId)
        throw new Error('invalid_transition_observer_version');
    const previous = new lambda.CfnVersion(scope, 'TransitionObserverVersion', { functionName: observer.functionName });
    previous.overrideLogicalId(previousLogicalId);
    previous.applyRemovalPolicy(RemovalPolicy.RETAIN);
    if (previous.node.tryGetContext(PATH_METADATA_ENABLE_CONTEXT))
        previous.addMetadata('aws:cdk:path', observer.currentVersion.node.path + '/Resource');
    previous.addMetadata('aws:cdk:do-not-refactor', true);
    // A separate attachment keeps the default policy's exact current-version row unchanged.
    new iam.Policy(scope, 'TransitionObserverPolicy', { roles: [role as iam.Role],
        statements: [new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [previous.ref] })] });
    return previous;
}
