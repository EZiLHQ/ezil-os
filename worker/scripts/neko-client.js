/* Runs inside the Neko origin. Reuse its keyboard and clipboard transport. */
(function () {
    'use strict';
    var attempts = 0;
    function configureClipboardHost(client) {
        if (client.__ezilClipboardHost || typeof client['system/init'] !== 'function') return;
        client.__ezilClipboardHost = true;
        var requested = new WeakSet();
        function request(implicitHosting) {
            var socket = client._ws;
            if (implicitHosting !== true || !socket || socket.readyState !== 1 || requested.has(socket)) return;
            // Mark before sending: a lock/rejection must never trigger a retry loop.
            requested.add(socket);
            try {
                // sendMessage also requires WebRTC, which need not be ready yet.
                // Send directly without invoking the store's control-request UI.
                socket.send(JSON.stringify({ event: 'control/request' }));
            } catch (_) { /* A closing socket gets another attempt only on reconnect. */ }
        }

        // Pinned m1k1o/neko@d74052bb: plugins/neko.ts:20 exposes window.$client;
        // neko/base.ts:22,70 exposes _ws; neko/index.ts:46 exposes $accessor.
        // base.ts:429-432 dispatches system/init on this same client each login.
        var init = client['system/init'];
        client['system/init'] = function (payload) {
            var result = init.apply(this, arguments);
            request(payload && payload.implicit_hosting);
            return result;
        };
        // Cover injection after system/init but before WebRTC finishes. The
        // upstream CONNECTED handler runs after initialization (index.ts:91).
        var connected = client.CONNECTED;
        if (typeof connected === 'function') {
            client.CONNECTED = function () {
                var result = connected.apply(this, arguments);
                request(client.$accessor.remote.implicitHosting);
                return result;
            };
        }
        // The store defaults implicitHosting to true BEFORE system/init. Only
        // trust it for an already connected viewer (late script injection).
        // For new sockets use the server payload above, including reconnects.
        if (client.connected && client.$accessor && client.$accessor.remote) {
            request(client.$accessor.remote.implicitHosting);
        }
    }
    function configure() {
        var client = window.$client;
        if (client) configureClipboardHost(client);
        var overlay = document.querySelector('textarea.overlay');
        if (!client || !overlay) {
            if (++attempts < 120) window.setTimeout(configure, 250);
            else console.warn('[ezil-input] Neko client/overlay unavailable');
            return;
        }

        // Clipboard is Neko's own: its client syncs once the browser exposes
        // navigator.clipboard to this frame and the server has a real host.
        // Never touch clipboard state here
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
