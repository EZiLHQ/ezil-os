// Offline bridge to the authoritative lifecycle contract. No SDK/client imports.
import { readFileSync } from 'node:fs';
import { validateLifecycleReceipt } from './lib/lifecycle/intent.js';
try {
  const { work, output } = JSON.parse(readFileSync(0, 'utf8'));
  // createdAt is local work metadata, not an evidence capture/event timestamp.
  validateLifecycleReceipt({ ...work, createdAt: new Date(0) }, output);
} catch { process.exitCode = 1; }
