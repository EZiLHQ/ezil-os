export default {
    root: '/dev/shm/ezil-unified-20261026/os-credits/app',
    cacheDir: '/dev/shm/ezil-unified-20261026/os-credits/.task-tmp/vite',
    test: { environment: 'node', include: ['src/**/*.test.ts'], maxWorkers: 1, minWorkers: 1, cache: false },
    resolve: { alias: { '@': '/dev/shm/ezil-unified-20261026/os-credits/app/src' } },
};
