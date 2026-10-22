import assert from 'node:assert/strict';
export const list = (v: any): any[] => v === undefined ? [] : [v].flat();
const matches = (pattern: string, value: string) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$').test(value);
export function evaluate(statements: any[], action: string, resource: string, context: Record<string, unknown>) {
    const applicable = statements.filter(s => (s.NotAction ? !list(s.NotAction).some(p => matches(p, action)) : list(s.Action).some(p => matches(p, action)))
        && (s.NotResource ? !list(s.NotResource).some(p => matches(p, resource)) : list(s.Resource).some(p => matches(p, resource)))
        && Object.entries(s.Condition ?? {}).every(([op, entries]) => Object.entries(entries as any).every(([key, expected]) => {
            const values = list(context[key]).map(String), wanted = list(expected).map(String);
            if (op === 'Null') return String(values.length === 0) === expected;
            if (['StringEquals', 'ArnEquals', 'Bool'].includes(op)) return values.length > 0 && values.every(v => wanted.includes(v));
            if (['StringNotEquals', 'ArnNotEquals'].includes(op)) return values.every(v => !wanted.includes(v));
            if (op === 'ForAllValues:StringEquals') return values.every(v => wanted.includes(v));
            if (op === 'ForAnyValue:StringEquals') return values.some(v => wanted.includes(v));
            if (op === 'ForAnyValue:StringNotEquals') return values.some(v => !wanted.includes(v));
            if (op === 'NumericGreaterThanEquals') return values.length > 0 && values.every(v => Number(v) >= Number(wanted[0]));
            if (op === 'NumericLessThanEquals') return values.length > 0 && values.every(v => Number(v) <= Number(wanted[0]));
            assert.fail('unhandled IAM condition ' + op);
        })));
    return { allowed: applicable.some(s => s.Effect === 'Allow') && !applicable.some(s => s.Effect === 'Deny'),
        denied: applicable.some(s => s.Effect === 'Deny') };
}
