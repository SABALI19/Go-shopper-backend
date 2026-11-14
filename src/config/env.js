import dotenv from "dotenv";
import { getCheckoutPricing } from "./checkoutPricing.js";

// Backend development restarts on .env changes so updated local credentials are loaded.
dotenv.config();

export function getConfig() {
  const required = ["MONGODB_URI", "AUTH_ACCESS_TOKEN_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required backend environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`);
  }
  if (process.env.AUTH_ACCESS_TOKEN_SECRET.length < 32) throw new Error("AUTH_ACCESS_TOKEN_SECRET must contain at least 32 characters.");

  const nodeEnv = process.env.NODE_ENV || "development";
  const webAppUrl = (process.env.WEB_APP_URL || "").trim().replace(/\/$/, "");
  if (nodeEnv === "production") {
    let parsedWebUrl;
    try { parsedWebUrl = new URL(webAppUrl); } catch { throw new Error("WEB_APP_URL must be set to the deployed onboarding website URL."); }
    if (parsedWebUrl.protocol !== "https:") throw new Error("WEB_APP_URL must use HTTPS in production.");
    if (!process.env.CORS_ORIGINS) throw new Error("CORS_ORIGINS must include the deployed website origin in production.");
  }

  return {
    port: Number(process.env.PORT || 4000),
    mongoUri: process.env.MONGODB_URI,
    authAccessTokenSecret: process.env.AUTH_ACCESS_TOKEN_SECRET,
    nodeEnv,
    webAppUrl,
    corsOrigins: (process.env.CORS_ORIGINS || "http://localhost:8081,http://localhost:19006")
      .split(",").map((origin) => origin.trim()).filter(Boolean),
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
