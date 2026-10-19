import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import test from 'node:test';
import { App, BootstraplessSynthesizer, assertions } from 'aws-cdk-lib';
import { DeployIdentityStack, IdentityConfigSchema, boundaryStatements } from '../lib/identity.js';

/** Frozen from the implementation BEFORE Design A. Never regenerate this with
 * UPDATE_IAM_SNAPSHOT: it is the independent non-widening reference, including
 * the old Sids and both conditional fences. Current snapshots may evolve. */
const before = JSON.parse(readFileSync(join(__dirname, 'fixtures/identity-before-design-a.json'), 'utf8'));
type Statement = Record<string, any>;
const list = (value: string | string[] | undefined): string[] => value === undefined ? [] : [value].flat();

/** Billing v2 explicitly adds these two x86 types. Keep the historical fixture
 * frozen and every other action/resource/condition inside its old ceiling. */
function billingV2Ceiling(statements: Statement[]): Statement[] {
    return statements.map(statement => {
        const types = statement.Condition?.StringEquals?.['ec2:InstanceType'];
        if (!types) return statement;
        assert.deepEqual(types, ['t3a.medium', 't3.medium', 'm6i.large', 'c6i.xlarge']);
        const updated = structuredClone(statement);
        updated.Condition.StringEquals['ec2:InstanceType'] = [...types, 'm6i.xlarge', 'm6i.2xlarge'];
        return updated;
    });
}

/** Conservative language containment, not matching a wildcard as a literal.
 * Exact equality and a single trailing wildcard cover our ARN/action shapes.
 * Unknown wildcard relationships fail closed. */
function patternWithin(inner: string, outer: string): boolean {
    if (inner === outer || outer === '*') return true;
    if (/^[^*?]*\*$/.test(outer)) return inner.startsWith(outer.slice(0, -1));
    if (/[*?]/.test(inner)) return false;
    const expression = outer.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp('^' + expression + '$').test(inner);
}

/** An allow can add conditions, but cannot drop or weaken an old condition.
 * Only equality value subsets are generalized; other operators must be exact. */
function conditionsWithin(inner: Statement = {}, outer: Statement = {}): boolean {
    return Object.entries(outer).every(([operator, entries]) => Object.entries(entries as Statement).every(([key, value]) => {
        const actual = inner[operator]?.[key];
        if (actual === undefined) return false;
        if (operator === 'StringEquals' || operator === 'ArnEquals')
            return list(actual).every(v => list(value as string | string[]).includes(v));
        return JSON.stringify(actual) === JSON.stringify(value);
    }));
}

function assertAllowsWithin(statements: Statement[], ceiling: Statement[]) {
    for (const statement of statements.filter(s => s.Effect === 'Allow')) {
        assert.ok(statement.Action && statement.Resource && !statement.NotAction && !statement.NotResource);
        for (const action of list(statement.Action)) for (const resource of list(statement.Resource))
            assert.ok(ceiling.some(old => old.Effect === 'Allow'
                && list(old.Action).some(a => patternWithin(action, a))
                && list(old.Resource).some(r => patternWithin(resource, r))
                && conditionsWithin(statement.Condition, old.Condition)),
            `allow exceeds old boundary: ${action} ${resource} ${JSON.stringify(statement.Condition)}`);
    }
}

/** Each old deny atom must have an equal or broader attached deny. For
 * NotResource/NotAction, demand exact equality unless a global Action deny
 * covers the old Action. This proves coverage without sampling IAM contexts. */
function assertDeniesRetained(oldStatements: Statement[], current: Statement[]) {
    const denies = current.filter(s => s.Effect === 'Deny');
    for (const old of oldStatements.filter(s => s.Effect === 'Deny')) {
        if (old.NotAction) {
            const { Sid, ...expected } = old;
            assert.ok(denies.some(s => {
                const { Sid: ignored, ...actual } = s;
                // Property order in synthesized JSON is not significant.
                try { assert.deepEqual(actual, expected); return true; } catch { return false; }
            }), `lost NotAction deny: ${Sid}`);
            continue;
        }
        for (const action of list(old.Action)) assert.ok(denies.some(s =>
            list(s.Action).some(a => patternWithin(action, a))
            && conditionsWithin(old.Condition, s.Condition)
            && (s.Resource === '*' || (old.NotResource
                ? JSON.stringify(s.NotResource) === JSON.stringify(old.NotResource)
                : !s.NotResource && list(old.Resource).every(r => list(s.Resource).some(n => patternWithin(r, n)))))),
        `lost deny: ${old.Sid} ${action}`);
    }
}

/** Reviewed grants added after Design A. Each must still fit inside the legacy
 * boundary (assertAllowsWithin below); everything else stays frozen.
 * 2026-10-14 live: CreateStateMachine/DescribeStateMachine with a customer key
 * call KMS as the CloudFormation caller, via Step Functions. */
function addedAfterDesignA(c: { region: string; accountId: string; namespace: string }): Record<string, Statement[]> {
    return { deploy: [], exec: [{ Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Effect: 'Allow', Resource: `arn:aws:kms:${c.region}:${c.accountId}:key/*`,
        Condition: { StringEquals: { 'aws:RequestedRegion': c.region, 'aws:ResourceTag/ezil:namespace': c.namespace,
            'kms:ViaService': `states.${c.region}.amazonaws.com` } } }] };
}

for (const killSwitch of [false, true]) for (const userDataAttributeKeyVerified of [false, true]) {
    test(`Design A: unchanged identity grants, old allow containment and attached denies ${JSON.stringify({ killSwitch, userDataAttributeKeyVerified })}`, () => {
        const config = IdentityConfigSchema.parse({ ...before.config, killSwitch, userDataAttributeKeyVerified });
        const legacy = billingV2Ceiling([
            ...before.boundary.filter((s: Statement) => !(userDataAttributeKeyVerified && s.Sid === 'NoModifyInstanceAttribute')),
            ...(userDataAttributeKeyVerified ? before.userData : []),
            ...(killSwitch ? [before.killSwitch] : []),
        ]);
        const stack = new DeployIdentityStack(new App({ autoSynth: false }), 'IdentityContainment', {
            config, env: { account: config.accountId, region: config.region }, synthesizer: new BootstraplessSynthesizer(),
        });
        const resources = assertions.Template.fromStack(stack).toJSON().Resources as Record<string, any>;
        const roles = Object.entries(resources).filter(([, r]) => r.Type === 'AWS::IAM::Role');
        assert.equal(roles.length, 2);
        for (const [id, role] of roles) {
            const name = role.Properties.RoleName.endsWith('-cfn-exec') ? 'exec' : 'deploy';
            assert.equal(role.Properties.PermissionsBoundary, undefined);
            const inline = (role.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement);
            // Also catch any separately attached inline policy, not just Policies.
            for (const resource of Object.values(resources)) {
                const p = resource.Properties;
                if ((resource.Type === 'AWS::IAM::Policy' && p.Roles?.some((r: any) => r.Ref === id))
                    || (resource.Type === 'AWS::IAM::RolePolicy' && p.RoleName?.Ref === id))
                    inline.push(...p.PolicyDocument.Statement);
            }
            const added = addedAfterDesignA(config)[name]!;
            const frozen = inline.filter((s: Statement) => !added.some(a => isDeepStrictEqual(a, s)));
            assert.equal(inline.length - frozen.length, added.length, `${name} reviewed additions missing`);
            assert.deepEqual(frozen, before[name], `${name} inline policy changed`);
            assertAllowsWithin(inline, legacy);
            // The shortened purchase bans may deny entire services only because
            // neither deployment identity uses any action in these services.
            for (const service of ['savingsplans', 'rds', 'elasticache', 'redshift', 'es', 'dynamodb', 'aws-marketplace'])
                assert.ok(!inline.some((s: Statement) => list(s.Action).some(a => a.startsWith(service + ':'))),
                    `purchase Deny would block ${name}'s ${service} path`);
            const attached = role.Properties.ManagedPolicyArns;
            assert.equal(attached.length, 1);
            const fences = attached.flatMap((ref: any) => {
                const policy = resources[ref.Ref];
                assert.equal(policy?.Type, 'AWS::IAM::ManagedPolicy');
                assert.equal(policy.Properties.Path, '/ezil/identity/');
                assert.ok(policy.Properties.PolicyDocument.Statement.every((s: Statement) => s.Effect === 'Deny'));
                return policy.Properties.PolicyDocument.Statement;
            });
            assertDeniesRetained(legacy, fences);
        }
        const workload = boundaryStatements(config).map(s => s.toStatementJson());
        assertAllowsWithin(workload, legacy);
        assertDeniesRetained(legacy, workload);
    });
}

test('containment proof rejects removed tags, wider resources, weaker role conditions and missing denies', () => {
    const ceiling = billingV2Ceiling(before.boundary);
    const launch = structuredClone(ceiling.find(s => s.Condition?.StringEquals?.['ec2:InstanceType']));
    assert.ok(launch);
    launch.Condition.StringEquals['ec2:InstanceType'].push('m6i.4xlarge');
    assert.throws(() => assertAllowsWithin([launch], ceiling), /exceeds old boundary/);
    for (const mutate of [
        (s: Statement) => { delete s.Condition; },
        (s: Statement) => { s.Resource = '*'; },
        (s: Statement) => { s.Condition.ArnEquals['cloudformation:RoleArn'] = '*'; },
    ]) {
        const grant = structuredClone(before.deploy[0]);
        mutate(grant);
        assert.throws(() => assertAllowsWithin([grant], before.boundary), /exceeds old boundary/);
    }
    const tagged = structuredClone(before.exec.find((s: Statement) => list(s.Action).includes('kms:PutKeyPolicy')));
    delete tagged.Condition.StringEquals['aws:ResourceTag/ezil:namespace'];
    assert.throws(() => assertAllowsWithin([tagged], before.boundary), /exceeds old boundary/);
    const deny = before.boundary.find((s: Statement) => s.Sid === 'RolesCarryThisBoundary');
    assert.throws(() => assertDeniesRetained([deny], []), /lost deny/);
    const weakened = structuredClone(deny);
    weakened.Condition.StringEquals = { 'aws:RequestedRegion': 'us-east-1' };
    assert.throws(() => assertDeniesRetained([deny], [weakened]), /lost deny/);
    assert.equal(patternWithin('ec2:Describe*', 'ec2:DescribeInstances'), false);
});
