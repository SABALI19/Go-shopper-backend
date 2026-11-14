import { createApp } from "./app.js";
import { getConfig } from "./config/env.js";
import { connectDatabase } from "./config/database.js";
import { startOrderReservationExpiryWorker } from "./features/orders/reservationWorker.js";
import { startApplicationNotificationWorker } from "./services/applicationNotificationOutbox.js";

let server;
let stopReservationWorker;
let stopApplicationNotificationWorker;
try {
  const config = getConfig();
  await connectDatabase(config.mongoUri);
  stopReservationWorker = startOrderReservationExpiryWorker({
    intervalSeconds: config.orderReservationSweepSeconds,
  });
  stopApplicationNotificationWorker = startApplicationNotificationWorker();
  const app = createApp(config);
  server = app.listen(config.port, "0.0.0.0", () => console.log(`Go-Shopper API listening on port ${config.port}`));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopReservationWorker?.();
    stopApplicationNotificationWorker?.();
    server?.close(() => process.exit(0));
  });
}
