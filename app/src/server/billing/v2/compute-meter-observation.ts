/** Also protect provider answers from a throwing injected meter or dependency factory. */
export async function recordComputeMeter<T>(observe: () => Promise<T> | undefined): Promise<T | undefined> {
    try {
        return await observe();
    } catch (error) {
        console.warn('[billing.meter] observation failed', { error });
    }
}

