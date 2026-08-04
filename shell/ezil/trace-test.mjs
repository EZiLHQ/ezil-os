// trace-test.mjs — EZiL-authored. Proves `trace.js` in plain Node, no bundle,
// no jsdom — it is a pure module with zero dependencies (see its own header).
//
// Run:  node shell/ezil/trace-test.mjs
import { ambientCorrelationId, ambientTraceRef, beginTrace, newEventId } from './trace.js';

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── newEventId: the SAME generator telemetry.js used to define itself ───────
push('newEventId() produces a v4 uuid', V4.test(newEventId()), newEventId());
{
    const ids = new Set(Array.from({ length: 500 }, () => newEventId()));
    push('500 calls to newEventId() are all distinct', ids.size === 500, `${ids.size}/500`);
}

// ── beginTrace: id, ambient pointer ──────────────────────────────────────────
push('no trace is ambient before beginTrace() is called', ambientCorrelationId() === undefined);

{
    const t = beginTrace('desktop');
    push('beginTrace() returns a v4-uuid id', V4.test(t.id), t.id);
    push('beginTrace() makes itself the ambient trace', ambientCorrelationId() === t.id);
    push('ambientTraceRef() returns the same trace object', ambientTraceRef() === t);
    t.end('ok');
    push('.end() clears the ambient pointer', ambientCorrelationId() === undefined);
}

// ── step()/end(): breadcrumbs become an ordered "code:ms" phases string ─────
{
    const t = beginTrace('preview');
    t.step('a');
    t.step('b');
    t.step('c');
    const summary = t.end('ok');
    const codes = summary.phases.split(',').map((p) => p.split(':')[0]);
    push('phases string lists breadcrumbs in the order step() was called', JSON.stringify(codes) === JSON.stringify(['a', 'b', 'c']), summary.phases);
    push('each breadcrumb entry is "code:ms"', /^a:\d+,b:\d+,c:\d+$/.test(summary.phases), summary.phases);
    push('summary carries the trace id as correlationId', summary.correlationId === t.id);
    push('summary carries the outcome passed to end()', summary.outcome === 'ok');
    push('summary.totalMs is a non-negative number', typeof summary.totalMs === 'number' && summary.totalMs >= 0);
}

// ── 🔴 exactly one summary per trace: end() is idempotent ───────────────────
{
    const t = beginTrace('code');
    const first = t.end('ok');
    const second = t.end('ok');
    push('🔴 the FIRST end() call returns a real summary', first !== null);
    push('🔴 a SECOND end() call on the same trace returns null — never a duplicate boot_summary', second === null);
}

// ── an outcome outside the closed set is coerced to "error", never smuggled ─
{
    const t = beginTrace('x');
    const summary = t.end('whatever');
    push('an unrecognised outcome string is coerced to "error"', summary.outcome === 'error', summary.outcome);
}
{
    const t = beginTrace('x');
    const summary = t.end('skipped');
    push('"skipped" is a recognised outcome, passed through unchanged', summary.outcome === 'skipped');
}
{
    const t = beginTrace('x');
    const summary = t.end(); // no argument at all
    push('end() with no argument defaults to "ok"', summary.outcome === 'ok');
}

// ── step() after end() is a no-op, not a crash and not a resurrected trace ──
{
    const t = beginTrace('x');
    t.end('ok');
    let threw = false;
    try { t.step('too-late'); } catch { threw = true; }
    push('step() after end() never throws', ! threw);
}

// ── breadcrumbs are capped — an unbounded caller cannot grow the phases string forever ─
{
    const t = beginTrace('x');
    for ( let i = 0; i < 100; i++ ) t.step(`s${i}`);
    const summary = t.end('ok');
    const count = summary.phases.split(',').filter(Boolean).length;
    push('breadcrumbs are capped at MAX_BREADCRUMBS (24) even when step() is called 100 times', count <= 24, `${count} breadcrumbs`);
}

// ── phases string is capped at the wire's MAX_ATTR_STRING_LEN (160) ─────────
{
    const t = beginTrace('x');
    for ( let i = 0; i < 24; i++ ) t.step(`a-very-long-phase-code-name-${i}`);
    const summary = t.end('ok');
    push('phases string never exceeds 160 chars (MAX_ATTR_STRING_LEN)', summary.phases.length <= 160, `${summary.phases.length} chars`);
}

// ── two overlapping traces don't corrupt each other's breadcrumbs ───────────
{
    const outer = beginTrace('outer');
    outer.step('outer-1');
    const inner = beginTrace('inner'); // becomes ambient, replacing `outer`
    push('a NEW beginTrace() replaces the ambient pointer', ambientCorrelationId() === inner.id);
    inner.step('inner-1');
    const innerSummary = inner.end('ok');
    push('the inner trace only ever sees its own breadcrumb', innerSummary.phases === 'inner-1:' + innerSummary.phases.split(':')[1]);
    // The outer trace is no longer ambient, but its own object still works.
    outer.step('outer-2');
    const outerSummary = outer.end('ok');
    const outerCodes = outerSummary.phases.split(',').map((p) => p.split(':')[0]);
    push('the outer trace still records its own steps after no longer being ambient', JSON.stringify(outerCodes) === JSON.stringify(['outer-1', 'outer-2']), outerSummary.phases);
}

console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
if ( checks.some((c) => ! c.pass) ) process.exit(1);
