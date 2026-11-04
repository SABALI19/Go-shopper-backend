import { createApp } from "./app.js";
import { getConfig } from "./config/env.js";
import { connectDatabase } from "./config/database.js";

let server;
try {
  const config = getConfig();
  await connectDatabase(config.mongoUri);
  const app = createApp(config);
  server = app.listen(config.port, "0.0.0.0", () => console.log(`Go-Shopper API listening on port ${config.port}`));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server?.close(() => process.exit(0)));
}
