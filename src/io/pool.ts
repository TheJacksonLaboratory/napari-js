/**
 * Bounded-concurrency and cancellation helpers shared by the tile I/O functions
 * ({@link readLevel}, {@link assembleVolume}). Internal: not part of the public API.
 */

/** The error an aborted operation rejects with: the signal's reason, else an `AbortError`. */
export function abortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** Throw if `signal` has fired. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Settle with `promise`, or reject as soon as `signal` aborts, whichever is first. The
 * underlying work is not cancelled (it may not support cancellation); `onLate` receives its
 * value if it resolves after the abort, so the caller can release it (e.g. close a bitmap).
 */
export function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onLate?: (value: T) => void,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.then(onLate, () => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      promise.then(onLate, () => undefined);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) onLate?.(value);
        else resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Run `task(i)` for `i = 0 … count-1` with at most `concurrency` in flight. Rejects with the
 * first failure (no further tasks start after it) or when `signal` aborts. Tasks already in
 * flight are not interrupted beyond what they do with `signal` themselves.
 */
export async function runPool(
  count: number,
  concurrency: number,
  task: (index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < count) {
      throwIfAborted(signal);
      const i = next++;
      try {
        await task(i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(concurrency) || 1, count));
  await Promise.all(Array.from({ length: count > 0 ? width : 0 }, worker));
}
