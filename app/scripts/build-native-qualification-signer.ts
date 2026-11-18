/** From the app directory: bun scripts/build-native-qualification-signer.ts /private/signer.mjs */
import { fileURLToPath } from 'node:url';

const output = process.argv[2];
if (process.argv.length !== 3 || !output?.endsWith('.mjs')) {
    console.error('Usage: bun scripts/build-native-qualification-signer.ts <output.mjs>');
    process.exit(1);
}
// The CLI runs only on the server. Next supplies this same empty marker for server builds.
const marker = fileURLToPath(import.meta.resolve('next/dist/compiled/server-only/empty.js'));
const bundle = await Bun.build({
    entrypoints: [fileURLToPath(new URL('native-qualification-sign.ts', import.meta.url))],
    target: 'node',
    format: 'esm',
    env: 'disable',
    plugins: [{
        name: 'next-server-marker',
        setup(build) {
            build.onResolve({ filter: /^server-only$/ }, () => ({ path: marker }));
        },
    }],
});
if (!bundle.success || bundle.outputs.length !== 1) {
    console.error('Native qualification signer bundle failed.');
    process.exit(1);
}
await Bun.write(output, bundle.outputs[0]);
