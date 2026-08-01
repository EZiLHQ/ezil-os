/**
 * Vitest config for `computers-drift.test.tsx` — GUARANTEE #2.
 *
 * ── Why this config exists at all ───────────────────────────────────────────
 * The test it runs asserts that `/computers` — the escape hatch a user needs
 * when the OS shell fails to boot — still renders. That test therefore has to
 * live under `app/`'s module graph, but the FILE has to live in this task's
 * owned paths (`shell/ezil/ui/Settings/**`, `shell/ezil/apps/registry.js`,
 * `shell/PUTER-PROVENANCE.md`), because a file written outside them is
 * discarded at merge. `app/vitest.config.ts`'s `include` is
 * `['src/**\/*.test.ts']`, which reaches neither this directory nor `.tsx`.
 *
 * So: the config and the test sit here, and both point their `root` at
 * `app/`, which gives the test app/'s `@/*` alias, app/'s `node_modules`, and
 * app/'s TypeScript settings. Run it with
 *
 *     cd app && bunx vitest run --config ../shell/ezil/ui/Settings/computers-drift.vitest.config.ts
 *
 * 🔴 FOR THE INTEGRATOR: the RIGHT home for this test is
 * `app/src/app/computers/route-drift.test.tsx`, where `bunx vitest run` picks
 * it up with everything else and nobody has to remember a second command.
 * Moving it needs a one-line rename of `.test.tsx` -> the app suite's `.test.ts`
 * convention (or widening `include` to `.tsx`) and deleting this file. That
 * move is a change under `app/`, which this task does not own.
 */
//
// 🔴 No `import { defineConfig } from 'vitest/config'`. Vite resolves a config
// file's own imports from the config file's DIRECTORY, and this directory has
// no `node_modules` — `shell/node_modules` holds only jsdom, and vitest lives
// under `app/node_modules`. OBSERVED: importing it fails with
// `Cannot find module 'vitest/config'` before the config is even read. A plain
// exported object is a valid vitest config and needs nothing resolved.
import path from 'node:path';

const here = __dirname;
const appRoot = path.resolve(here, '../../../../app');

export default ({
    root: appRoot,
    test: {
        // `node`, not `jsdom` — app/ has no jsdom dependency and adding one is
        // a change to a file this task does not own. `react-dom/server` is
        // enough: this test asks what the page RENDERS, not how it behaves
        // under a click, and the app suite already covers the behaviour
        // (`delete-copy.test.ts`, `computer-limit.test.ts`).
        environment: 'node',
        include: [path.resolve(here, 'computers-drift.test.tsx')],
    },
    resolve: {
        alias: {
            '@': path.resolve(appRoot, 'src'),
            // 🔴 The test FILE lives outside `root`, so vite resolves its bare
            // specifiers against the file's own directory — which is inside
            // `shell/`, where there is no React. OBSERVED: `react-dom/server`
            // resolved to the non-existent `app/react-dom/server`. Pointing
            // the three React entry points at app/'s real copies is what makes
            // an out-of-root test file work at all; everything the test then
            // imports transitively comes from `app/node_modules` normally.
            'react-dom/server': path.resolve(appRoot, 'node_modules/react-dom/server.js'),
            'react/jsx-runtime': path.resolve(appRoot, 'node_modules/react/jsx-runtime.js'),
            react: path.resolve(appRoot, 'node_modules/react'),
            // `/computer/[id]/page` reaches `@/trpc/server`, which imports
            // `server-only` — a Next bundler marker with no runtime entry
            // point. See ./server-only.stub.ts.
            'server-only': path.resolve(here, 'server-only.stub.ts'),
            'next/navigation': path.resolve(here, 'next-navigation.stub.ts'),
        },
    },
    // The test file is outside `root`, so app/'s `"jsx": "react-jsx"` does not
    // reach it and esbuild falls back to the classic transform — which fails
    // at runtime with `React is not defined`. State it here instead.
    esbuild: { jsx: 'automatic' },
});
