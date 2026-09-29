/** Human-readable message for anything thrown (Error, SDK error objects, strings). */
export function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message);
    return String(error);
}
