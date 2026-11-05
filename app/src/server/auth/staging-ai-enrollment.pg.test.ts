import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

// The premise of the driver test's backend model, checked against a real server: with the enrollment
// client's options, postgres.js serializes a jsonb parameter itself, so only a bound object is stored
// as a jsonb object (what the AI-credit outbox claim reads with payload->>'protocol').
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('postgres.js jsonb parameters with the enrollment client options', () => {
    it('stores a bound object as a jsonb object and a pre-stringified payload as a jsonb string', async () => {
        const client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false, fetch_types: false, onnotice: () => {} });
        try {
            const payload = { protocol: 'ezil-ai-credits-v1', credits: 100 };
            const stored = async (value: postgres.ParameterOrJSON<never>) => (await client.unsafe<{ type: string; protocol: string | null }[]>(
                "select jsonb_typeof($1::jsonb) as type, $1::jsonb->>'protocol' as protocol", [value]))[0];
            expect(await stored(payload as postgres.JSONValue)).toEqual({ type: 'object', protocol: 'ezil-ai-credits-v1' });
            expect(await stored(JSON.stringify(payload))).toEqual({ type: 'string', protocol: null });
        } finally {
            await client.end();
        }
    });
});
