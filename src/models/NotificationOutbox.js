import mongoose from "mongoose";

const schema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  kind: { type: String, required: true },
  to: { type: String, required: true, select: false },
  subject: { type: String, required: true, select: false },
  text: { type: String, required: true, select: false },
  html: { type: String, required: true, select: false },
  status: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending", index: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  acceptedAt: Date,
  lastError: { type: String, select: false },
}, { timestamps: true });

export const NotificationOutbox = mongoose.models.NotificationOutbox || mongoose.model("NotificationOutbox", schema);
