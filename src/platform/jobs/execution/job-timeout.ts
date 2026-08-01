import { JobTimeoutError } from "./job-failure";

/**
 * A bounded attempt.
 *
 * BullMQ has no general per-job execution timeout to lean on, so one is built
 * here, and it is built around cancellation rather than around a race.
 * `Promise.race` on its own is the tempting version and the wrong one: it
 * resolves the caller while the work carries on in the background, still holding
 * a database connection, still about to write, and now with nobody watching it.
 * A second attempt then runs alongside the first.
 *
 * So the signal is aborted first and the handler is still awaited. A handler
 * that passes the signal on — to `fetch`, to a query, to another
 * `AbortController` — unwinds promptly and the attempt fails as a timeout. A
 * handler that ignores it keeps the worker slot until it finishes, which is
 * visible, bounded by BullMQ's stalled-job detection, and infinitely preferable
 * to two copies of the same work running at once.
 *
 * The timer is cleared in `finally`, always: an uncleared timer keeps the event
 * loop alive and turns a clean shutdown into a hang.
 */
export async function runWithJobTimeout<T>(
  timeoutMs: number,
  retryable: boolean,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new JobTimeoutError(retryable));
  }, timeoutMs);

  try {
    const result = await run(controller.signal);

    // The handler finished, but it finished late. Reporting success here would
    // hide a job that is quietly outgrowing its budget until the day it stops
    // finishing at all.
    if (timedOut) {
      throw new JobTimeoutError(retryable);
    }

    return result;
  } catch (error) {
    // A handler that honours the signal usually rejects with an `AbortError` of
    // its own. The timeout is the real cause, and it is the one reported.
    if (timedOut) {
      throw new JobTimeoutError(retryable, { cause: error });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}
