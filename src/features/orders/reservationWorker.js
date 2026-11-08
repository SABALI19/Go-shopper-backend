import { expirePendingOrderReservations } from "./service.js";

export function startOrderReservationExpiryWorker({ intervalSeconds = 60, expireReservations = expirePendingOrderReservations } = {}) {
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try {
      await expireReservations();
    } catch (error) {
      console.error(`Order reservation expiry sweep failed: ${error.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), intervalSeconds * 1000);
  timer.unref?.();
  void sweep();
  return () => clearInterval(timer);
}
