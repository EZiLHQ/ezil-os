/**
 * Layout-only Chromium checks; every write request is intercepted and aborted.
 * Start the local app with its development environment guards, then run:
 * PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules node e2e/login-layout.mjs
 * Optional: LOGIN_BASE_URL, LOGIN_SCREENSHOTS, PLAYWRIGHT_CHROMIUM_EXECUTABLE.
 * Keyboard checks resize the viewport; they do not emulate a native keyboard
 * or constitute physical Samsung Internet testing. Exit 2 means unable to run.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

const base = new URL(process.env.LOGIN_BASE_URL || 'http://127.0.0.1:3141');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Use a local app server');
const screenshots = path.resolve(process.env.LOGIN_SCREENSHOTS || '/tmp/ezil-login-layout');
let browser;
try {
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch {
        const require = createRequire(path.join(path.resolve(process.env.PLAYWRIGHT_REQUIRE_DIR || 'node_modules'), 'probe.cjs'));
        ({ chromium } = require('playwright'));
    }
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
        args: ['--no-sandbox'],
    });
    const response = await fetch(new URL('/login', base), { signal: AbortSignal.timeout(15_000) });
    assert(response.ok, 'Local login route must return success');
    assert.match(await response.text(), /interactive-widget=resizes-content/, 'Login has its own keyboard policy before hydration');
    await mkdir(screenshots, { recursive: true });
} catch (error) {
    console.error(`UNABLE TO RUN: ${error.message.split('\n')[0]}`);
    await browser?.close();
    process.exit(2);
}

const sizes = [
    ['small', 320, 568], ['s8-s9', 360, 740], ['s24', 384, 824],
    ['s24-ultra', 412, 915], ['landscape', 915, 412], ['tablet', 768, 1024],
    ['desktop', 1440, 900], ['short-desktop', 1440, 480],
];
const modes = [
    ['default', ''], ['callback-error', '?error=auth_callback_failed'],
    ['email', '?method=email'], ['email-error', '?method=email&error=auth_callback_failed'],
];
let passed = 0;
let failed = 0;
let blockedWrites = 0;

async function contextFor(width, height, extra = {}) {
    const context = await browser.newContext({
        viewport: { width, height }, isMobile: width < 1024, hasTouch: width < 1024,
        ...extra,
    });
    await context.route('**/*', route => {
        const request = route.request();
        if (!['GET', 'HEAD'].includes(request.method())) {
            blockedWrites++;
            return route.abort('failed');
        }
        if (new URL(request.url()).origin !== base.origin) return route.abort('blockedbyclient');
        return route.continue();
    });
    return context;
}

async function ready(page, query = '') {
    await page.goto(new URL(`/login${query}`, base).href, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('.ezil-lock-time')?.textContent.trim());
    await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    assert.match(await page.locator('meta[name=viewport]').getAttribute('content'), /interactive-widget=resizes-content/);
}

async function reachable(page, locator) {
    await locator.scrollIntoViewIfNeeded();
    assert(await locator.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        return x >= 0 && x <= innerWidth && y >= 0 && y <= innerHeight
            && (hit === element || element.contains(hit));
    }), 'Control must be scrollable into view and unobstructed');
}

async function geometry(page, fit = false) {
    const measured = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
            width: innerWidth, height: innerHeight,
            scrollWidth: document.documentElement.scrollWidth,
            scrollHeight: document.documentElement.scrollHeight,
            sections: ['.ezil-lock-brand', '.ezil-lock-clock', '.ezil-lock-profile', '.ezil-lock-footer'].map(rect),
            targets: [...document.querySelectorAll('.ezil-lock a, .ezil-lock button, .ezil-lock input:not([type=hidden])')]
                .filter(element => element.getClientRects().length)
                .map(element => ({ name: element.textContent.trim() || element.id, ...element.getBoundingClientRect().toJSON() })),
        };
    });
    assert(measured.scrollWidth <= measured.width + 1, 'No horizontal document overflow');
    if (fit) assert(measured.scrollHeight <= measured.height + 1, 'Default mode fits the viewport');
    measured.sections.forEach((rect, index, sections) => {
        assert(rect.left >= 0 && rect.right <= measured.width + 1, 'Section fits horizontally');
        if (index) assert(rect.top >= sections[index - 1].bottom + 4, 'Header, clock, profile and footer do not overlap');
    });
    for (const target of measured.targets) {
        assert(target.width >= 44 && target.height >= 44, `44px touch target: ${target.name}`);
    }
    assert.equal(await page.locator('.ezil-lock-google').count(), 1, 'Exactly one Google action');
    for (const target of await page.locator('.ezil-lock button:visible, .ezil-lock input:visible, .ezil-lock-footer a').all()) {
        await reachable(page, target);
    }
    return measured;
}

async function check(name, operation) {
    try {
        await operation();
        passed++;
        console.log(`PASS ${name}`);
    } catch (error) {
        failed++;
        console.error(`FAIL ${name}: ${error.message}`);
    }
}

try {
    for (const [device, width, height] of sizes) {
        const context = await contextFor(width, height);
        const page = await context.newPage();
        try {
            for (const [mode, query] of modes) {
                await check(`${device} ${width}x${height} ${mode}`, async () => {
                    await ready(page, query);
                    if (mode === 'email-error') {
                        // Exercise the actual client error UI without a request
                        // reaching Next's action or an authentication provider.
                        await page.locator('#email').fill('layout@example.invalid');
                        await page.locator('#password').fill('layout-only-placeholder');
                        await page.locator('.ezil-lock-password').click();
                        await page.locator('.ezil-lock-auth [role=alert]').waitFor();
                    }
                    await geometry(page, mode === 'default');
                    await page.evaluate(() => scrollTo(0, 0));
                });
                await page.screenshot({ path: path.join(screenshots, `${device}-${mode}.png`), fullPage: true });
            }
        } finally { await context.close(); }
    }

    await check('disclosure focus, retained input and reduced motion', async () => {
        const context = await contextFor(360, 740, { reducedMotion: 'reduce' });
        try {
            const page = await context.newPage();
            await ready(page);
            assert.equal(await page.locator('.ezil-lock-profile').evaluate(el => getComputedStyle(el).animationName), 'none');
            await page.locator('.ezil-lock-disclosure').click();
            await page.waitForFunction(() => document.activeElement?.id === 'email');
            await page.locator('#email').fill('layout@example.invalid');
            await page.locator('.ezil-lock-disclosure').click();
            assert(await page.locator('.ezil-lock-disclosure').evaluate(el => el === document.activeElement));
            await page.locator('.ezil-lock-disclosure').click();
            assert.equal(await page.locator('#email').inputValue(), 'layout@example.invalid');
        } finally { await context.close(); }
    });

    for (const [name, width, height, enlarged] of [
        ['text-200-percent', 320, 568, true],
        ['desktop-200-percent-reflow', 720, 450, false],
        ['keyboard-resize', 384, 300, false],
        ['landscape-keyboard-resize', 915, 220, false],
    ]) {
        await check(name, async () => {
            const context = await contextFor(width, Math.max(height, 824), { reducedMotion: 'reduce', locale: 'de-DE' });
            try {
                const page = await context.newPage();
                await ready(page, '?method=email&error=auth_callback_failed');
                if (enlarged) await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
                await page.locator('#password').focus();
                await page.setViewportSize({ width, height });
                await page.keyboard.press('Tab');
                assert(await page.locator('.ezil-lock-password').evaluate(el => el === document.activeElement));
                await reachable(page, page.locator('.ezil-lock-password'));
                await geometry(page);
                await page.screenshot({ path: path.join(screenshots, `${name}.png`), fullPage: true });
            } finally { await context.close(); }
        });
    }
} finally { await browser.close(); }
console.log(`${passed} passed / ${failed} failed; ${blockedWrites} writes intercepted; screenshots: ${screenshots}`);
process.exitCode = failed ? 1 : 0;
