// The one credit formatter for the extension (a leaf: status-data.ts and gateway.ts both import it).
// Integer microcredits in (1 credit = 1,000,000), text out, never through a float. The OS shell's
// `creditsDecimal` (shell/ezil/ui/Settings/billing-format.js) follows the same rule and vectors.

/** Every microcredit, trailing zeros trimmed, en-US grouping: 1,246.75 · 0.000001 · 9,007,199,254.740991. For per-request charges and policy limits; balances and totals use creditsWhole. */
export function credits(value: number | string): string {
    // Format integer microcredits exactly, including window strings beyond Number's safe range.
    const amount = BigInt(value);
    const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
    return (amount / 1_000_000n).toLocaleString('en-US') + (fraction ? `.${fraction}` : '');
}

/** Whole credits, floored (a balance is never shown as more than it is) and never below 0: 99.999 → 99 · 1,246.75 → 1,246. Display only: the exact microcredits stay in the accounting. */
export function creditsWhole(value: number | string): string {
    const amount = BigInt(value);
    return (amount < 0n ? 0n : amount / 1_000_000n).toLocaleString('en-US');
}
