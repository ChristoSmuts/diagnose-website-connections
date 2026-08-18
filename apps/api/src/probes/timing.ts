/** Monotonic elapsed-time helper. */
export function stopwatch(): () => number {
  const start = process.hrtime.bigint();
  // hrtime rather than Date.now(): immune to clock adjustments, and sub-ms
  // resolution matters when a fast TLS handshake is only a few milliseconds.
  return () => Number(process.hrtime.bigint() - start) / 1e6;
}

/**
 * Reject after `ms`, cleaning up the timer either way.
 *
 * A leaked timer keeps the event loop alive and would stop the process exiting,
 * which matters because every probe races several of these.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Narrow an unknown catch value to a readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
