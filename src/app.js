import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { configureClerk } from "./middleware/auth.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { createUsersRouter } from "./routes/users.js";
import { storesRouter } from "./routes/stores.js";
import { createCheckoutRouter } from "./routes/checkout.js";
import { createOrdersRouter } from "./routes/orders.js";
import { createStoreOrdersRouter } from "./routes/storeOrders.js";
import { createAdminRouter, getEffectiveCheckoutPricing } from "./routes/admin.js";
import { getCheckoutPricing } from "./config/checkoutPricing.js";
import { createAdminStoresRouter } from "./routes/adminStores.js";
import { createRiderRouter } from "./routes/rider.js";
import { createAdminDeliveriesRouter } from "./routes/adminDeliveries.js";
import { applicationsRouter, createAdminApplicationsRouter } from "./routes/applications.js";
import { requireRoles } from "./middleware/auth.js";

export function createApp(config) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS"));
    },
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.json({ status: "ok", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
  });

  configureClerk(app, config);
  const pricingProvider = () => getEffectiveCheckoutPricing(undefined, () => config.checkoutPricing || getCheckoutPricing());
  app.use("/api/checkout", createCheckoutRouter({
    pricingProvider,
  }));
  app.use("/api/orders", createOrdersRouter({
    pricingProvider,
    reservationTtlMinutes: config.orderReservationTtlMinutes,
  }));
  app.use("/api/rider", createRiderRouter());
  app.use("/api/admin/deliveries", createAdminDeliveriesRouter());
  app.use("/api/applications", applicationsRouter);
  app.use("/api/admin/applications", createAdminApplicationsRouter({ authorizeAdmin: requireRoles("admin") }));
  app.use("/api/users", createUsersRouter({ adminEmail: config.adminEmail }));
  app.use("/api/admin", createAdminRouter());
  app.use("/api/stores", createAdminStoresRouter());
  app.use("/api/stores", createStoreOrdersRouter());
  app.use("/api/stores", storesRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
