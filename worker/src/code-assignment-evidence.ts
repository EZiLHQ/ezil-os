import { INFERENCE_VALIDATOR_SOURCE } from '../../app/src/server/ai-traces/contract.js';

export const ASSIGNMENT_EVIDENCE_BRIDGE_MARKER = 'data-ezil-assignment-evidence';
const STAGING = 'https://os-staging.ezil.work';

/** Runs only in a staged workbench document. The shell arms it after consent. */
export function codeAssignmentEvidenceScript(): string {
    return String.raw`(() => {
        if (window.parent === window) return;
        const origin = "https://os-staging.ezil.work";
        const query = new URLSearchParams(location.search);
        const folder = query.get("folder");
        const mint = query.get("ezil_mint");
        const token = value => typeof value === "string" && /^[A-Za-z0-9_-]{22}$/.exec(value)?.[0] === value;
        if (query.has("workspace") || query.getAll("folder").length !== 1 || query.getAll("ezil_mint").length !== 1
            || !/^\/workspace\/projects\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(folder ?? "") || !token(mint)) return;
        const validateTrace = ${INFERENCE_VALIDATOR_SOURCE};
        let capture = null;

        function send(kind, detail) {
            if (!capture) return;
            window.parent.postMessage({ type: "ezil.code.assignment.event", v: 1, nonce: capture.nonce, kind, detail }, origin);
        }

        function editorPath(editor, root) {
            const raw = editor.getAttribute("data-uri");
            if (typeof raw !== "string" || raw.length > 1024 || /%(?:2e|2f|5c|00)/i.test(raw)) return null;
            try {
                const uri = new URL(raw);
                if ((uri.protocol !== "vscode-remote:" || !uri.hostname) && (uri.protocol !== "file:" || uri.host)) return null;
                if (uri.search || uri.hash || uri.username || uri.password) return null;
                const path = decodeURIComponent(uri.pathname);
                if (!path.startsWith(root + "/")) return null;
                const relative = path.slice(root.length + 1);
                return relative.length <= 240 && !relative.includes("..")
                    && relative.split("/").every(part => /^[A-Za-z0-9._-][A-Za-z0-9 ._-]{0,95}$/.exec(part)?.[0] === part
                        && part !== "." && !/^\.(?:git$|env|(?:aws|ssh|gnupg|npmrc|netrc|pypirc)$)|^\.?(?:id_(?:rsa|dsa|ecdsa|ed25519)|credentials|secrets)(?:\.|$)|\.(?:pem|p12|pfx|key|crt|cer|der|kdbx)$/i.test(part))
                    ? relative : null;
            } catch { return null; }
        }

        function currentEditor() {
            const editors = [...document.querySelectorAll(".part.editor .editor-group-container.active .editor-container .monaco-editor[data-uri]")]
                .filter(element => element.getClientRects().length && !element.closest(".monaco-diff-editor, .monaco-editor .monaco-editor, .notebook-editor"));
            return editors.length === 1 ? editors[0] : null;
        }

        function sample(initial) {
            if (!capture || document.visibilityState !== "visible") return;
            const editor = currentEditor();
            const path = editor && editorPath(editor, capture.root);
            const changed = path !== capture.path;
            capture.path = path;
            if (changed) capture.range = null;
            if (!path) return;
            // The active editor changed. Selecting an existing tab can also do this.
            if (changed && !initial) send("code.file_opened", { path });

            // The pinned editor patch answers with absolute Monaco model line numbers.
            // An older editor or a viewport split by folds supplies no range evidence.
            let range;
            editor.dispatchEvent(new CustomEvent("ezil:assignment-code-visible-range", {
                detail: { uri: editor.getAttribute("data-uri"), report: value => { range = value; } },
            }));
            if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isSafeInteger)
                || range[0] <= 0 || range[1] < range[0] || range[1] > 1000000) return;
            const previous = capture.range;
            capture.range = range;
            if (previous && (previous[0] !== range[0] || previous[1] !== range[1])) {
                send("code.file_reviewed", { path, startLine: range[0], endLine: range[1] });
            }
        }

        function onTrace(event) {
            try {
                if (!capture || typeof event.detail !== "string" || event.detail.length > 4096) return;
                const trace = validateTrace(JSON.parse(event.detail));
                if (!trace || capture.seen.has(trace.requestId)) return;
                if (capture.seen.size >= 512) capture.seen.delete(capture.seen.values().next().value);
                capture.seen.add(trace.requestId);
                send("model.completed", { requestId: trace.requestId, model: trace.modelAlias, outcome: trace.outcome });
            } catch { /* An unsupported trace produces no assignment event. */ }
        }

        function stop() {
            if (!capture) return;
            clearInterval(capture.interval);
            window.removeEventListener("ezil-ai-request-trace", onTrace);
            capture = null;
        }

        window.addEventListener("message", event => {
            const d = event.data;
            if (event.source !== window.parent || event.origin !== origin || !d || typeof d !== "object"
                || Array.isArray(d) || d.v !== 1 || !token(d.nonce)) return;
            if (d.type === "ezil.code.assignment.stop" && d.nonce === capture?.nonce) stop();
            if (d.type !== "ezil.code.assignment.start" || d.mint !== mint || typeof d.root !== "string"
                || !d.root.startsWith(folder + "/")) return;
            const name = d.root.slice(folder.length + 1);
            if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(name) || name.includes("..") || name.endsWith(".") || name.endsWith(".git")) return;
            stop();
            capture = { root: d.root, nonce: d.nonce, path: null, range: null, seen: new Set(), interval: 0 };
            sample(true);
            capture.interval = setInterval(() => sample(false), 400);
            window.addEventListener("ezil-ai-request-trace", onTrace);
        });
        window.addEventListener("pagehide", stop);
    })();`;
}

export function codeAssignmentEvidenceTag(origins: readonly string[], nonce: string): string {
    if (origins.length !== 1 || origins[0] !== STAGING || !/^[A-Za-z0-9+/=_-]{8,128}$/.test(nonce)) return '';
    const script = codeAssignmentEvidenceScript();
    if (/<\/|<!--/.test(script)) return '';
    return '<script nonce="' + nonce + '" ' + ASSIGNMENT_EVIDENCE_BRIDGE_MARKER + '="1">' + script + '</script>';
}
