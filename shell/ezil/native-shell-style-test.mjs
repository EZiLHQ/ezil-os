import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const css = readFileSync(new URL('./ui/ezil-shell.css', import.meta.url), 'utf8');
const settings = readFileSync(new URL('./ui/Settings/settings.css', import.meta.url), 'utf8');
const dom = new JSDOM(`<!doctype html><style>body { color: black; font-family: serif; }</style>
<style>${settings}\n${css}</style><body class="device-desktop">
<div class="desktop" style="background: rgb(13, 43, 45)"></div>
<div class="window"><div class="ezil-settings-row"><span class="ezil-settings-row-slot">1</span>
<div class="ezil-settings-row-meta"><div class="ezil-settings-row-name">Local desktop audit</div><div class="ezil-settings-row-sub">EZiL-managed project</div></div>
<div class="ezil-settings-row-actions"><button class="ezil-settings-btn">Open project folder…</button><button class="ezil-settings-btn">VS Code</button><button class="ezil-settings-btn">Xcode</button><button class="ezil-settings-btn">Rename</button><button class="ezil-settings-btn">Delete</button></div></div>
<form class="ezil-settings-rename-form"><input class="ezil-settings-input"></form>
<form class="ezil-native-browser-toolbar" style="background: rgb(24,25,27)"><button style="color:inherit" aria-label="Back">‹</button>
<input aria-label="Browser address" placeholder="Enter a web address" style="color:inherit;background:rgba(255,255,255,.08)"><span role="status">Page failed to load</span></form></div>`, { pretendToBeVisual: true });
const { document, getComputedStyle } = dom.window;
const style = selector => getComputedStyle(document.querySelector(selector));
assert.match(style('.window').fontFamily, /-apple-system/);
assert.match(style('body').fontFamily, /sans-serif/);
assert.match(style('.ezil-settings-btn').fontFamily, /-apple-system/);
assert.equal(style('.ezil-native-browser-toolbar').color, 'rgb(245, 245, 244)');
assert.equal(style('.ezil-native-browser-toolbar button').color, 'rgb(245, 245, 244)');
assert.equal(style('.ezil-native-browser-toolbar input').color, 'rgb(245, 245, 244)');
assert.equal(style('.ezil-native-browser-toolbar input').boxSizing, 'border-box');
// Verify the final cascade allows line breaks at the pane width rather than
// relying on viewport media queries. JSDOM does not claim pixel layout coverage.
assert.equal(style('.ezil-settings-row').flexWrap, 'wrap');
assert.equal(style('.ezil-settings-row-meta').flexBasis, '224px');
assert.equal(style('.ezil-settings-row-actions').flexWrap, 'wrap');
assert.equal(style('.ezil-settings-row-actions').flexShrink, '1');
for (const selector of ['.ezil-settings-row-name', '.ezil-settings-row-sub', '.ezil-settings-row-actions button']) {
    assert.equal(style(selector).whiteSpace, 'normal'); assert.equal(style(selector).overflowWrap, 'anywhere');
}
assert.equal(style('.ezil-settings-row-actions button').maxWidth, '100%');
assert.equal(style('.ezil-settings-rename-form').flexWrap, 'wrap');
assert.equal(style('.desktop').backgroundColor, 'rgb(13, 43, 45)', 'stored wallpaper remains authoritative');

const declarations = selector => {
    const found = {};
    for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
        if (rule.selectorText?.split(',').some(item => item.trim() === selector)) {
            for (let i = 0; i < rule.style.length; i++) {
                const property = rule.style.item(i); found[property] = rule.style.getPropertyValue(property);
            }
        }
    }
    return found;
};
for (const control of ['button', 'input']) {
    const focus = declarations(`.ezil-native-browser-toolbar ${control}:focus-visible`);
    assert.equal(focus.outline, '2px solid #f5f5f4'); assert.equal(focus['outline-offset'], '2px');
}
const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
const ratio = (a, b) => (luminance(a) + .05) / (luminance(b) + .05);
const inputBackground = [24, 25, 27].map(value => value * .92 + 255 * .08);
assert.ok(ratio([245, 245, 244], inputBackground) >= 4.5);
assert.ok(ratio([182, 182, 179], inputBackground) >= 4.5);
assert.equal(declarations('.ezil-native-browser-toolbar input::placeholder').color, 'rgb(182, 182, 179)');
dom.window.close();
console.log('PASS shell font cascade, Browser contrast/focus rules, project action wrapping and stored wallpaper preservation (no pixel geometry assertions)');
