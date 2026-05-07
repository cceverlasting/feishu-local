import { TimeoutError } from "./errors.js";

export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message = `Operation timed out after ${timeoutMs}ms`
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TimeoutError(message)), timeoutMs);

  try {
    return await task(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !(error instanceof TimeoutError)) {
      throw new TimeoutError(message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
