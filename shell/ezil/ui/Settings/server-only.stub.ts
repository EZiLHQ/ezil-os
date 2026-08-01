// Stub for the `server-only` package — see computers-drift.vitest.config.ts.
// `server-only` exists to make Next fail a build that imports server code into
// a client bundle. Under vitest there is no such boundary to protect, and the
// real package has no importable entry point outside Next's bundler.
export {};
