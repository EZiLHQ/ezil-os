import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated, minified build output of `shell/build-shell.sh` — checked in
    // only so the app needs no shell build step (see that script's header).
    // It is esbuild's output over Puter-derived vendored code, not source
    // anyone edits here, and linting it produced 70 errors / 1300+ warnings
    // that no one can act on: `bun run lint` was red on `main` for this
    // reason alone. The shell tree is linted at its own source, not here.
    "public/os/**",
  ]),
]);

export default eslintConfig;
