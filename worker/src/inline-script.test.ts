import { describe, expect, it } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { inlineScriptBodies, scriptJson } from './inline-script';
import { codePreviewBridgeScript } from './code-preview-bridge';
import { buildDiagnosticResponse, previewInspectorScript } from './preview-bridge';

describe('scriptJson', () => {
  const hostile = ['</script><script>alert(1)</script>', '<!--', '-->', 'a\u2028b\u2029c', 'https://x.test/</sCrIpT>'];

  it('round-trips as JSON and as a JavaScript expression, unchanged', () => {
    for (const value of [hostile, { origins: hostile, n: 1 }, 'plain', 3]) {
      expect(JSON.parse(scriptJson(value))).toEqual(value);
      expect(runInNewContext(`(${scriptJson(value)})`)).toEqual(value);
    }
  });

  it('never emits anything that can close the element, open a comment or end the line', () => {
    const out = scriptJson(hostile);
    expect(out).not.toMatch(/[<>\u2028\u2029]/);
    expect(out.toLowerCase()).not.toContain('</script');
    expect(out).not.toContain('<!--');
  });

  it('is what every bridge script embeds: a hostile origin list stays inert inside the injected code', () => {
    for (const script of [codePreviewBridgeScript(hostile), previewInspectorScript(hostile)]) {
      expect(script.toLowerCase()).not.toContain('</script');
      expect(script).not.toMatch(/[\u2028\u2029]/);
    }
  });
});

describe('inlineScriptBodies', () => {
  it('returns plain <script> bodies in order and ignores an unterminated one', () => {
    expect(inlineScriptBodies('<p>x</p><script>a()</script> <script>b()</script><script>c(')).toEqual(['a()', 'b()']);
    expect(inlineScriptBodies('no scripts')).toEqual([]);
  });

  it('is linear on adversarial input (no backtracking)', () => {
    const big = '<script>'.repeat(200_000);
    const t = performance.now();
    expect(inlineScriptBodies(big)).toEqual([]);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it('reads the diagnostic page responder the Worker actually serves', async () => {
    const html = await buildDiagnosticResponse('upstream_error', 3002, undefined, ['https://8443-x-code.ezil.org']).text();
    expect(inlineScriptBodies(html).some((b) => b.includes('ezil.preview.state'))).toBe(true);
  });
});
