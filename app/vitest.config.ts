import path from 'node:path';
import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
    },
    resolve: {
        alias: [
            { find: '@', replacement: path.resolve(__dirname, './src') },
            // These tests execute in Node, outside Next's server compiler. Use the same
            // marker Next supplies for server modules; production/client guards stay intact.
            { find: /^server-only$/, replacement: require.resolve('next/dist/compiled/server-only/empty') },
        ],
    },
});
