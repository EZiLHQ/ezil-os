import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('desktop iframe delegates clipboard both ways and allows normal focus', () => {
    const source = readFileSync(new URL('./desktop-window.js', import.meta.url), 'utf8');
    const start = source.indexOf("const el_iframe = el_window.querySelector('.window-app-iframe');");
    const end = source.indexOf('// ── the desktop', start);
    assert.ok(start >= 0 && end > start);
    const attrs = new Map([['sandbox', 'allow-scripts allow-same-origin'], ['tabindex', '-1'], ['autofocus', '']]);
    const iframe = {
        setAttribute: (k, v) => attrs.set(k, v),
        removeAttribute: k => attrs.delete(k),
    };
    runInNewContext(source.slice(start, end), { el_window: { querySelector: () => iframe } });
    const allow = attrs.get('allow').split(';').map(v => v.trim());
    assert.ok(allow.includes('clipboard-read'));
    assert.ok(allow.includes('clipboard-write'));
    assert.equal(attrs.get('tabindex'), '0');
    assert.equal(attrs.has('autofocus'), false, 'focus must follow a user gesture');
    assert.equal(attrs.get('sandbox'), 'allow-scripts allow-same-origin');
});
