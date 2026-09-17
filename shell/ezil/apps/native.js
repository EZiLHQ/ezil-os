import UIWindow from '../../src/UI/UIWindow.js';
import { nativeOperation } from '../native-runtime.js';

export async function openNativeSurface (id, ctx) {
    const surface = id === 'code' ? 'code' : 'browser';
    const name = surface === 'code' ? 'VS Code' : 'Browser';
    const existing = document.querySelector(`.window[data-app="${id}"]:not([data-closing="1"])`);
    const el = existing ?? await UIWindow({
        title: ctx.appName, app: id, icon: ctx.icon, width: 420, height: 220,
        single_instance: true, show_in_taskbar: true, is_resizable: true,
        is_droppable: false, selectable_body: true,
        body_content: '<div style="padding:24px"><p class="ezil-native-status" role="status" aria-live="polite"></p><button type="button" class="ezil-native-reopen">Open again</button></div>',
    });
    if ( ! el ) return null;
    if ( existing ) $(el).showWindow();
    const status = el.querySelector('.ezil-native-status');
    const button = el.querySelector('.ezil-native-reopen');
    const run = async () => {
        if ( el.dataset.nativePending === 'true' ) return;
        el.dataset.nativePending = 'true';
        button.disabled = true;
        status.textContent = `Opening ${name}…`;
        const result = await nativeOperation({
            op: el.dataset.nativeState === 'opened' ? 'surface.focus' : 'surface.open',
            workspaceId: ctx.computer?.id, surface,
        });
        const opened = result?.ok === true && result?.state === 'opened';
        el.dataset.nativeState = opened ? 'opened' : 'unavailable';
        status.textContent = opened ? `${name} opened in its own window.`
            : `${name} is unavailable. You can keep using EZiL OS and try again later.`;
        el.dataset.nativePending = 'false';
        button.disabled = false;
    };
    button.onclick = () => { void run(); };
    void run();
    return el;
}

export function openNativeSettings (ctx) {
    return UIWindow({
        title: 'Settings', app: 'settings', icon: ctx.icon, width: 560, height: 340,
        single_instance: true, show_in_taskbar: true, is_resizable: true,
        is_droppable: false, selectable_body: true,
        body_content: '<div style="padding:24px"><h2>On this Mac</h2><p>Your guest workspace is stored on this Mac. Cloud sync is off.</p><p>Code opens in official VS Code. Browser opens in a separate Chromium window.</p><p>Programs run with your Mac account’s permissions. Native execution is trusted and is not isolated from your Mac.</p><p>Manage workspaces in the EZiL OS Mac app.</p></div>',
    });
}
