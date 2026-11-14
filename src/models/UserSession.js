import mongoose from "mongoose";

const userSessionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  refreshTokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null, index: true },
  lastUsedAt: { type: Date, default: Date.now },
  userAgent: { type: String, maxlength: 300, default: "" },
  ipAddress: { type: String, maxlength: 64, default: "" },
}, { timestamps: true, versionKey: false });
userSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserSession = mongoose.models.UserSession || mongoose.model("UserSession", userSessionSchema);
