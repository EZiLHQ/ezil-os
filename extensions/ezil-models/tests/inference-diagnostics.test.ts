import { expect, test } from 'bun:test';
import { InferenceTrace, InferenceRing, aggregateInference, toolCategory } from '../src/inference-diagnostics';
import { ask, call, msg, result, txt } from './fixtures/gateway';

test('independent write request, explicit acknowledgement and file verification; unknown never becomes success', () => {
    for (const state of [undefined, false, true]) {
        const output = { ...result('write', [txt('PRIVATE error text /private/file')]), isError: state } as ReturnType<typeof result>;
        const trace = new InferenceTrace('gemini-4-carbon', ask([msg('user', txt('PRIVATE prompt')), msg('assistant', call('write', 'replace_string_in_file', { filePath: '/private/file' })), msg('user', output)]));
        trace.event({ type: 'tool_call', callId: 'next', name: 'read_file', input: { filePath: '/private/file' } });
        const r = trace.finish(false, false);
        expect(r.writeRequested).toBe(false); expect(r.toolReportedSuccess).toBe(state === false); expect(r.verifiedFileChange).toBeNull();
        expect(r.results[state === undefined ? 'unknown' : state ? 'error' : 'reportedSuccess']).toBe(1);
        expect(r.toolResults[0]!.state).toBe(state === undefined ? 'unknown' : state ? 'error' : 'reported_success');
        expect(JSON.stringify(r)).not.toMatch(/PRIVATE|private\/file|replace_string_in_file|"call":"write"/);
    }
    const write = new InferenceTrace('gemini-4-carbon', ask());
    write.event({ type: 'tool_call', callId: 'a', name: 'replace_string_in_file', input: {} });
    expect(write.finish(false, false)).toMatchObject({ writeRequested: true, toolReportedSuccess: false, verifiedFileChange: null });
});
test('only latest assistant calls match results; duplicate and orphan results remain unmatched', () => {
    const trace = new InferenceTrace('gemini-4-carbon', ask([msg('assistant', call('old')), msg('user', result('old')),
        msg('assistant', call('a')), msg('assistant', call('b')), msg('user', result('a'), result('a'), result('b'), result('old'))]));
    expect(trace.finish(false, false).results).toEqual({ matched: 2, error: 0, reportedSuccess: 0, unknown: 2, unmatched: 2 });
});
test('bounded immutable snapshots and aggregate do not turn repeated reads into semantic failures', () => {
    const ring = new InferenceRing();
    for (let i = 0; i < 140; i++) {
        const trace = new InferenceTrace('gemini-4-carbon', ask());
        trace.event({ type: 'tool_call', callId: `call${i}`, name: 'read_file', input: {} }); ring.add(trace.finish(false, false));
    }
    const records = ring.snapshot(); expect(records).toHaveLength(128);
    expect(aggregateInference(records)).toMatchObject({ requests: 128, readOnlySuspicions: 128, verifiedFileChanges: null });
    expect(records.every(r => r.outcome === 'completed')).toBe(true);
    records[0]!.requested.read = 999; expect(ring.snapshot()[0]!.requested.read).toBe(1);
    expect(toolCategory('terminal_that_might_edit')).toBe('other');
});
