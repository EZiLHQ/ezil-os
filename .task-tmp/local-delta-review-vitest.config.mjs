import config from './vitest.config.mjs';
export default { ...config, test: { ...config.test, include: ['../.task-tmp/local-delta-review-repro.test.ts'] } };
