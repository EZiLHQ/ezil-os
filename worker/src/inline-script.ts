/**
 * Helpers for the small inline scripts the bridges inject into HTML they serve.
 *
 * `scriptJson` is JSON that is also safe inside an inline `<script>`: `<`, `>`, `/` and the JS line separators
 * U+2028/U+2029 become `\uXXXX`, so no embedded value can close the element, open a comment or end the line.
 *
 * `inlineScriptBodies` reads the bodies of plain `<script>…</script>` elements from markup WE built (never from a
 * response body), by linear scanning rather than a backtracking pattern.
 */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function inlineScriptBodies(markup: string): string[] {
  const open = '<script>', close = '</script>';
  const bodies: string[] = [];
  for (let at = 0; ;) {
    const start = markup.indexOf(open, at);
    if (start < 0) break;
    const end = markup.indexOf(close, start + open.length);
    if (end < 0) break;
    bodies.push(markup.slice(start + open.length, end));
    at = end + close.length;
  }
  return bodies;
}
