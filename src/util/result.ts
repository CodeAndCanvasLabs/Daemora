/**
 * Result<T, E> — typed success/failure without exceptions.
 *
 * Used at every fallible boundary in Daemora-TS. Throwing across module
 * boundaries is reserved for genuinely unrecoverable bugs. Recoverable
 * failures (provider down, file missing, validation failed) return a
 * Result so the caller has to handle them explicitly.
 */

export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Run an async function and capture any thrown value as a Result. */
export async function tryAsync<T, E = Error>(
  fn: () => Promise<T>,
  toError: (e: unknown) => E = (e) => e as E,
): Promise<Result<T, E>> {
  try {
    return ok(await fn());
  } catch (e) {
    return err(toError(e));
  }
}

/** Synchronous version. */
export function trySync<T, E = Error>(
  fn: () => T,
  toError: (e: unknown) => E = (e) => e as E,
): Result<T, E> {
  try {
    return ok(fn());
  } catch (e) {
    return err(toError(e));
  }
}

/** Unwrap a Result, throwing if it's an error. Use only at top of CLI / HTTP handler. */
export function unwrap<T>(r: Result<T, unknown>): T {
  if (r.ok) return r.value;
  throw r.error instanceof Error ? r.error : new Error(String(r.error));
}
