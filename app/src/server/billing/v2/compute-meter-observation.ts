/** Also protect provider answers from a throwing injected meter or dependency factory. */
export async function recordComputeMeter(observe: () => Promise<void> | undefined): Promise<void> {
    try {
        await observe();
    } catch (error) {
        console.warn('[billing.meter] observation failed', { error });
    }
}

