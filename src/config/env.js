import dotenv from "dotenv";
import { getCheckoutPricing } from "./checkoutPricing.js";

// Backend development restarts on .env changes so updated local credentials are loaded.
dotenv.config();

export function getConfig() {
  // Clerk middleware requires both the server secret and matching app publishable key.
  const required = ["MONGODB_URI", "CLERK_SECRET_KEY", "CLERK_PUBLISHABLE_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required backend environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`);
  }

  return {
    port: Number(process.env.PORT || 4000),
    mongoUri: process.env.MONGODB_URI,
    clerkSecretKey: process.env.CLERK_SECRET_KEY,
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY,
    adminEmail: (process.env.ADMIN_EMAIL || "").trim().toLowerCase(),
    corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:8081,http://localhost:19006")
      .split(",").map((origin) => origin.trim()).filter(Boolean),
    nodeEnv: process.env.NODE_ENV || "development",
    checkoutPricing: getCheckoutPricing(process.env),
    orderReservationTtlMinutes: positiveInteger(process.env.ORDER_RESERVATION_TTL_MINUTES, 15, "ORDER_RESERVATION_TTL_MINUTES"),
    orderReservationSweepSeconds: positiveInteger(process.env.ORDER_RESERVATION_SWEEP_SECONDS, 60, "ORDER_RESERVATION_SWEEP_SECONDS"),
  };
}

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
