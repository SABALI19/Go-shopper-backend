import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import { configureClerk } from "./middleware/auth.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { usersRouter } from "./routes/users.js";
import { storesRouter } from "./routes/stores.js";

export function createApp(config) {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by CORS"));
    },
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
  }));
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (req, res) => {
    res.json({ status: "ok", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
  });

  configureClerk(app, config);
  app.use("/api/users", usersRouter);
  app.use("/api/stores", storesRouter);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
