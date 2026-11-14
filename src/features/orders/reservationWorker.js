import { expirePendingOrderReservations } from "./service.js";

export function startOrderReservationExpiryWorker({
  intervalSeconds = 60,
  maxRetryDelaySeconds = 300,
  expireReservations = expirePendingOrderReservations,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 1) {
    throw new TypeError("intervalSeconds must be a positive integer");
  }
  if (!Number.isSafeInteger(maxRetryDelaySeconds) || maxRetryDelaySeconds < 1) {
    throw new TypeError("maxRetryDelaySeconds must be a positive integer");
  }
  const maxRetryDelayMs = Math.max(intervalSeconds, maxRetryDelaySeconds) * 1000;

  let running = false;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0;
  const sweep = async () => {
    if (running || now() < nextAttemptAt) return;
    running = true;
    try {
      await expireReservations();
      consecutiveFailures = 0;
      nextAttemptAt = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const retryDelayMs = Math.min(
        intervalSeconds * 1000 * (2 ** Math.min(consecutiveFailures - 1, 20)),
        maxRetryDelayMs,
      );
      nextAttemptAt = now() + retryDelayMs;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Order reservation expiry sweep failed; retry scheduled in ${retryDelayMs}ms: ${message}`);
    } finally {
      running = false;
    }
  };
  const timer = setIntervalFn(() => void sweep(), intervalSeconds * 1000);
  timer.unref?.();
  void sweep();
  return () => clearIntervalFn(timer);
}
