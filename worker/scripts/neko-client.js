/* Runs inside the Neko origin. Reuse its keyboard and clipboard transport. */
(function () {
    'use strict';
    var attempts = 0;
    function configure() {
        var client = window.$client;
        var overlay = document.querySelector('textarea.overlay');
        if (!client || !overlay) {
            if (++attempts < 120) window.setTimeout(configure, 250);
            else console.warn('[ezil-input] Neko client/overlay unavailable');
            return;
        }

        // Clipboard is Neko's own: its client syncs once the browser exposes
        // navigator.clipboard to this frame. Never touch clipboard state here
        // (the legacy store's setClipboard takes clipboard TEXT, not a flag).

        overlay.addEventListener('pointerdown', function (event) {
            if (event.pointerType !== 'touch') overlay.focus({ preventScroll: true });
        });

        // ezil-mobile.js already repairs the touch keyboard. On desktop,
        // preserve the upstream input listener that compositionstart removes
        // permanently, so plain input still works after committing an IME word.
        // Keep the event itself (Vue snapshots the textarea) and the existing
        // Unicode/dead-key mapping, modifiers and keyup/repeat handling intact.
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0) return;
        var compositionStart = false;
        overlay.addEventListener('compositionstart', function () { compositionStart = true; }, true);
        var remove = overlay.removeEventListener;
        overlay.removeEventListener = function (type, listener, options) {
            if (compositionStart && type === 'input') return;
            return remove.call(this, type, listener, options);
        };
        overlay.addEventListener('compositionstart', function () { compositionStart = false; });
    }
    configure();
}());
