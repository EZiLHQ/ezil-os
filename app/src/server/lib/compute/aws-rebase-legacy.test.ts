import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { buildRebasePreparation } from './aws-rebase-preparation';

// The shared golden fixture is the exact live legacy (1.0.2 → 1.0.5) preparation input. The app
// must produce these bytes; infra/app-computers/test/rebase-legacy.test.ts proves the deployed
// infra contract accepts them. The pair pins the contract without a cross-project import.
it('app legacy preparation reproduces the shared live golden bytes', () => {
    const fixture = resolve(__dirname, '../../../../../infra/app-computers/test/fixtures/rebase-legacy/preparation-input.json');
    const envelope = JSON.parse(readFileSync(fixture, 'utf8'));
    const work = buildRebasePreparation(JSON.parse(envelope.document));
    expect(work.document).toBe(envelope.document);
    expect(work.digest).toBe(envelope.digest);
    expect(JSON.parse(work.document).sourceDeployment.preparationStateMachineVersionArn).toBeNull();
});
