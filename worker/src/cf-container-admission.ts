/** Operator-only admission pause. It never changes an already-running container's lifecycle. */
export const CF_ADMISSION_ERROR = 'computer_updating';
export const CF_ADMISSION_RETRY_SECONDS = 10;

/**
 * Paused start hooks must RETURN without calling the SDK start implementation, even for a running container.
 * A later physical stop can therefore fail a request, but cannot turn a prior running check into a new start.
 * Unknown native status fails closed. Disabled does not read native state or change existing behavior.
 */
export function cfAdmissionRunningOnly(flag: string | undefined, running: () => unknown): boolean {
  if (flag !== '1') return false;
  let live = false;
  try { live = running() === true; } catch { /* Unknown never permits a new start. */ }
  if (!live) throw new Error(CF_ADMISSION_ERROR);
  return true;
}

export function isCfAdmissionError(error: unknown): boolean {
  return error instanceof Error && error.message === CF_ADMISSION_ERROR;
}

export function cfAdmissionResponse(headers: Record<string, string> = {}): Response {
  return Response.json({ ok: false, error: CF_ADMISSION_ERROR,
    notice: 'Computers are being updated. Please retry shortly.', retryAfterSeconds: CF_ADMISSION_RETRY_SECONDS }, {
    status: 503, headers: { ...headers, 'Cache-Control': 'no-store', 'Retry-After': String(CF_ADMISSION_RETRY_SECONDS) },
  });
}
