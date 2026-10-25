// Lets the reset reply leave the object before `ctx.abort()` discards it.
// Keep configuration outside index.ts: workerd treats its value exports as entrypoints.
export const ACCEPTANCE_RESET_DELAY_MS = 100;
