// Run: PLAYWRIGHT_REQUIRE_DIR=<dir with playwright> [PLAYWRIGHT_CHROMIUM_EXECUTABLE=<chrome>] node shell/ezil/ui/feedback/capture-browser-test.mjs
// Real Chromium, real vendored snapdom, real capture.js: checks the pixels of the tier A window snapshot.
// Skips (exit 0, says so) when no Playwright is configured; jsdom cannot rasterize, so this is the only
// test that proves a shell overlay above an embedded frame survives while frame and private content do not.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Same Playwright lookup and skip code (2) as the other shell browser suites.
let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch {
    if (process.env.PLAYWRIGHT_REQUIRE_DIR) {
        try { ({ chromium } = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR), 'probe.cjs'))('playwright')); } catch { /* Skip below. */ }
    }
}
if (!chromium) {
    console.error('SKIP: installed Playwright is unavailable; jsdom cannot prove capture pixels.');
    process.exit(2);
}
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
  <!-- A transformed window whose scrolled body holds a private field and a small frame. -->
  <div style="position:fixed;left:560px;top:400px;width:200px;height:150px;transform:translate(10px,10px);background:#ff00ff">
    <div id="scroller" style="height:150px;overflow:auto">
      <div style="position:relative;height:400px">
        <input value="SCROLLED_SECRET" style="position:absolute;left:10px;top:120px;width:100px;height:40px;
          color:#ff0000;background:#ff0000;border:0">
        <iframe srcdoc="<body style='background:#ff0000'></body>" style="position:absolute;left:120px;top:120px;width:60px;height:40px;border:0"></iframe>
      </div>
    </div>
  </div>
  <script>document.getElementById('scroller').scrollTop = 60;</script>
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
            windowEdge: at(45, 35), page: at(10, 10),
            // Transformed window (570..770, 410..560), scrolled by 60: field at (580..680, 470..510), frame (690..750, 470..510).
            scrolledField: at(630, 490), scrolledFrame: at(720, 490), scrolledWindow: at(600, 530), red };
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
    near(result.scrolledField, [0, 0, 0], 'a private field in a scrolled, transformed window is covered where it is shown');
    near(result.scrolledFrame, [128, 128, 128], 'a frame in a scrolled, transformed window is masked where it is shown');
    near(result.scrolledWindow, [255, 0, 255], 'that window itself stays visible');
    checks++; console.log('PASS masks follow transformed and scrolled placement');
    // Well above the form's 10% note threshold: this is the "large embedded app" case. The form still attaches
    // this image (overlay and all) with one note (feedback-test.mjs, "an embedded app in the window snapshot").
    assert.ok(result.frameCoverage > 0.6 && result.frameCoverage < 0.9, `frame coverage is reported (${result.frameCoverage})`);
    checks++; console.log('PASS frame coverage is reported for the caller');
} finally {
    await browser.close();
}
console.log(`\n${checks} real-browser capture checks passed.`);
