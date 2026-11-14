import mongoose from "mongoose";

const authChallengeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  purpose: { type: String, enum: ["email_verification", "phone_verification", "password_reset"], required: true },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  lastSentAt: { type: Date, default: Date.now },
}, { timestamps: true, versionKey: false });
authChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
authChallengeSchema.index({ userId: 1, purpose: 1, createdAt: -1 });

export const AuthChallenge = mongoose.models.AuthChallenge || mongoose.model("AuthChallenge", authChallengeSchema);
