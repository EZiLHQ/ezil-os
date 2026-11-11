// Run: PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> [PLAYWRIGHT_CHROMIUM_EXECUTABLE=<chrome>] node shell/ezil/ui/feedback/capture-browser-test.mjs
// Real Chromium, real vendored snapdom, real capture.js: checks the pixels of the tier A window snapshot.
// Skips (exit 0, says so) when no Playwright is configured; jsdom cannot rasterize, so this is the only
// test that proves a shell overlay above an embedded frame survives while frame and private content do not.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const requireDir = process.env.PLAYWRIGHT_REQUIRE_DIR;
if (!requireDir) {
    console.log('SKIP capture-browser-test: set PLAYWRIGHT_REQUIRE_DIR to run the real-browser capture check.');
    process.exit(0);
}
const { chromium } = createRequire(path.join(requireDir, 'noop.js'))('playwright');
const shellDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ORIGIN = 'https://shell.test';

// A full-window embedded app (same-origin srcdoc, so snapdom WOULD read it if the filter let it), a shell
// overlay stacked above it, and a private field. Red marks content that must never appear in the image.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;width:800px;height:600px;overflow:hidden;background:#0000ff">
  <div class="window" style="position:fixed;left:40px;top:30px;width:720px;height:540px;background:#ffff00">
    <iframe srcdoc="<body style='margin:0;background:#ff0000;color:#ff0000'>FRAME_SECRET</body>"
      style="position:absolute;left:10px;top:10px;width:700px;height:520px;border:0"></iframe>
    <div id="needs-operator" style="position:absolute;left:300px;top:250px;width:200px;height:100px;z-index:5;
      background:#00ff00;color:#000000;font:16px sans-serif">needs_operator</div>
    <input value="PRIVATE_SECRET" style="position:absolute;left:20px;top:20px;width:200px;height:40px;z-index:6;
      color:#ff0000;background:#ff0000;border:0">
  </div>
</body></html>`;

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html' };
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
let checks = 0;
try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== ORIGIN) return route.abort();
        if (url.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE });
        const file = url.pathname === '/os/vendor/snapdom-3.3.4.mjs'
            ? path.join(shellDir, 'src/lib/snapdom-3.3.4/snapdom.mjs')
            : path.join(shellDir, path.normalize(url.pathname).replace(/^\/+/, ''));
        if (!file.startsWith(shellDir + path.sep)) return route.abort();
        try {
            return route.fulfill({ status: 200, contentType: types[path.extname(file)] ?? 'application/octet-stream', body: await readFile(file) });
        } catch { return route.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(`${ORIGIN}/`);
    const result = await page.evaluate(async () => {
        const { capture_shell_snapshot } = await import('/ezil/ui/feedback/capture.js');
        const info = {};
        const canvas = await capture_shell_snapshot({ info });
        if (!canvas) return null;
        const { data, width, height } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        const at = (x, y) => Array.from(data.slice((y * width + x) * 4, (y * width + x) * 4 + 3));
        let red = 0;
        for (let i = 0; i < data.length; i += 4) if (data[i] > 180 && data[i + 1] < 80 && data[i + 2] < 80) red++;
        // Page coordinates: window at (40,30); frame (50..750, 40..560); overlay (340..540, 280..380); field (60..260, 50..90).
        return { width, height, frameCoverage: info.frameCoverage, overlay: at(440, 300), frame: at(150, 500), privateField: at(160, 70),
            windowEdge: at(45, 35), page: at(10, 10), red };
    });
    assert.ok(result, 'the snapshot was produced');
    const near = (actual, expected, label) => assert.ok(actual.every((v, i) => Math.abs(v - expected[i]) <= 24), `${label}: got rgb(${actual}), want about rgb(${expected})`);

    near(result.overlay, [0, 255, 0], 'the needs_operator overlay above the frame is visible');
    checks++; console.log('PASS a shell overlay stacked above an embedded frame survives the capture');
    near(result.frame, [128, 128, 128], 'the uncovered frame area is the grey mask');
    near(result.windowEdge, [255, 255, 0], 'the window around the frame is not covered by its mask');
    near(result.page, [0, 0, 255], 'the page outside the window is untouched');
    checks++; console.log('PASS the embedded frame area is masked grey at its own place and layer, and nowhere else');
    near(result.privateField, [0, 0, 0], 'the private field is covered black');
    assert.equal(result.red, 0, 'no frame or private-field pixel (red) appears anywhere');
    checks++; console.log('PASS no frame document or private field content is captured');
    assert.ok(result.frameCoverage > 0.6 && result.frameCoverage < 0.9, `frame coverage is reported (${result.frameCoverage})`);
    checks++; console.log('PASS frame coverage is reported for the caller');
} finally {
    await browser.close();
}
console.log(`\n${checks} real-browser capture checks passed.`);
