import mongoose from "mongoose";

const adminAuditSchema = new mongoose.Schema({
  actorClerkUserId: { type: String, required: true, index: true },
  action: { type: String, required: true, trim: true, maxlength: 100 },
  targetType: { type: String, required: true, enum: ["store", "user", "platform_settings", "order", "delivery", "application"], index: true },
  targetId: { type: String, required: true, index: true },
  reason: { type: String, trim: true, maxlength: 500, default: "" },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

adminAuditSchema.index({ createdAt: -1 });
adminAuditSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });

export const AdminAudit = mongoose.model("AdminAudit", adminAuditSchema);
