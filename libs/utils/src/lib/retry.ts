/**
 * Retries an async operation with exponential backoff. Only meant for
 * transient failures (network blips, brief upstream 5xx) — the operation
 * must be safe to call multiple times (e.g. it re-sends a Buffer, not a
 * single-use stream that's already been consumed on a prior attempt).
 */
export async function retry<T>(
  operation: () => Promise<T>,
  options?: { attempts?: number; delayMs?: number },
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const delayMs = options?.delayMs ?? 500;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
