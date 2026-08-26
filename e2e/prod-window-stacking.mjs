/**
 * prod-window-stacking.mjs — a window must open where the user can reach it,
 * against the LIVE deployment.
 *
 * Run:  PLAYWRIGHT_REQUIRE_DIR=/opt/ezil-testkit/node_modules node e2e/prod-window-stacking.mjs
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BUG THIS EXISTS FOR
 * ═══════════════════════════════════════════════════════════════════════════
 * On a phone, tapping Settings in the full-bleed desktop's drawer opened a
 * Settings window the user could not see or touch: `elementFromPoint` at
 * Settings' OWN close button returned the DESKTOP's body. It failed 4 runs in
 * 5 locally and was invisible to every production suite, because every one of
 * them measures the desktop and none of them opens a second window.
 *
 * Z-order here is decided by FOCUS, not by `last_window_zindex` — `style.css`
 * gives every `.window` `z-index: 9999999 !important`, so focused = 9999999
 * and unfocused = 9999998. `$.fn.showWindow` focuses on a
 * `setTimeout(..., 80)`, so a desktop being restored lands its focus in the
 * future and can arrive AFTER a window opened on top of it.
 *
 * 🔴 The drawer is COLLAPSED by default, and this test learned that the hard
 * way: tapping the Settings button's coordinates while collapsed hits the
 * drawer TOGGLE instead, and Settings never opens at all. A coordinate tap
 * goes to whatever is topmost, never to an element — so this expands the
 * drawer first and then waits until the button is genuinely the topmost thing
 * at its own centre before tapping it.
 */
// Does Settings open ON TOP on a real phone against production?
import { createRequire } from 'node:module'; import path from 'node:path';
const req = createRequire(path.join('/opt/ezil-testkit/node_modules','noop.js'));
const { chromium } = req('playwright');
const b = await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']});
let ok = 0, runs = 3;
for (let n = 1; n <= runs; n++) {
  const ctx = await b.newContext({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true, deviceScaleFactor:3,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const p = await ctx.newPage();
  await p.goto('https://ezil-os.vercel.app/login',{waitUntil:'domcontentloaded'});
  await p.fill('#email','<redacted-email>'); await p.fill('#password','<redacted-password>');
  await Promise.all([p.waitForURL(u=>!/\/login/.test(u.toString()),{timeout:60000}).catch(()=>{}),
    p.locator('form').filter({has:p.locator('#email')}).locator('button[type=submit]').click()]);
  await p.goto('https://ezil-os.vercel.app/os',{waitUntil:'domcontentloaded'});
  await p.waitForTimeout(3000);
  try { await p.locator('.taskbar-item').filter({hasText:/browser/i}).first().click({timeout:12000}); }
  catch { await p.locator('.taskbar-item').nth(1).click({timeout:12000}).catch(()=>{}); }
  await p.waitForSelector('.window[data-app="desktop"] iframe.window-app-iframe',{timeout:180000}).catch(()=>{});
  await p.waitForFunction(()=>document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),null,{timeout:60000}).catch(()=>{});
  await p.waitForTimeout(5000);
  // The drawer is collapsed by default; expand it the way a user does.
  const toggle = await p.evaluate(()=>{ const t=document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-toggle');
    if(!t) return null; const r=t.getBoundingClientRect(); return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]; });
  if (toggle) { await p.touchscreen.tap(toggle[0], toggle[1]); await p.waitForTimeout(900); }
  // Wait until the Settings button is genuinely the topmost thing at its own
  // centre — a coordinate tap goes to whatever is on top, not to an element.
  await p.waitForFunction(() => {
    const b = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-settings');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    if (r.width <= 0) return false;
    const hit = document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
    return !!hit && (hit === b || b.contains(hit));
  }, null, { timeout: 8000 }).catch(()=>{});
  const btn = await p.evaluate(()=>{ const b=document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-settings');
    if(!b) return null; const r=b.getBoundingClientRect(); return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2)]; });
  if (!btn) { console.log(`run${n}: no drawer Settings button`); await ctx.close(); continue; }
  const pre = await p.evaluate(() => {
    const b = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-settings');
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2));
    const drawer = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer');
    const dcs = drawer ? getComputedStyle(drawer) : null;
    return { btnRect:[r.left,r.top,r.width,r.height].map(Math.round),
             btnVisible: r.width>0 && r.height>0,
             topmostAtBtn: hit?.className || null,
             drawerClasses: drawer?.className || null,
             drawerWidth: dcs?.width, drawerOpacity: dcs?.opacity, drawerPE: dcs?.pointerEvents };
  });
  console.log(`  pre-tap: ${JSON.stringify(pre)}`);
  await p.touchscreen.tap(btn[0], btn[1]);
  await p.waitForTimeout(2500);
  const r = await p.evaluate(()=>{
    const s=document.querySelector('.window[data-app="settings"]');
    if(!s) return {ok:false,why:'settings never opened'};
    const cb=s.querySelector('.window-head > .window-close-btn');
    if(!cb) return {ok:false,why:'no close button'};
    const rr=cb.getBoundingClientRect();
    const hit=document.elementFromPoint(Math.round(rr.left+rr.width/2),Math.round(rr.top+rr.height/2));
    const owner=hit?.closest?.('.window')?.getAttribute?.('data-app')??null;
    const z=(el)=>Number.parseInt(getComputedStyle(el).zIndex,10)||0;
    return { ok: owner==='settings', owner,
             settingsZ: z(s), desktopZ: z(document.querySelector('.window[data-app="desktop"]')) };
  });
  if (r.ok) ok++;
  console.log(`run${n}: ${r.ok?'PASS':'FAIL'}  settingsZ=${r.settingsZ} desktopZ=${r.desktopZ} topmostOwner=${r.owner ?? r.why}`);
  await ctx.close();
}
console.log(`\nSettings opens on top: ${ok}/${runs}`);
await b.close();
process.exit(ok === runs ? 0 : 1);
