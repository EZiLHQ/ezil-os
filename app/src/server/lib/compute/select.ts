/**
 * Choose the `ComputeProvider` for one computer (docs/AWS-COMPUTERS.md C-1,
 * R13: provider is chosen PER COMPUTER, never by a global flip).
 *
 * Today every computer is a Cloudflare computer: there is no placement table
 * yet (C-2), and "no row" means `cloudflare` + `r2`. Placement-aware dispatch,
 * including fail-closed handling of more than one row or an unknown enum
 * value, lands with the placement reader in a later PR (plan row P3).
 *
 * Returns the concrete adapter type, not bare `ComputeProvider`, so callers
 * keep the Worker's full result objects while there is only one provider.
 */

import { cloudflareComputeProvider, type CloudflareComputeProvider } from './cloudflare';
import type { ComputerRef } from './provider';

export function selectComputeProvider(computer: ComputerRef): CloudflareComputeProvider {
    void computer; // Read by placement dispatch (P3); every computer is Cloudflare today.
    return cloudflareComputeProvider;
}
