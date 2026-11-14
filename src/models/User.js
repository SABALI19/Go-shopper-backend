import mongoose from "mongoose";

const riderProfileSchema = new mongoose.Schema({
  approvalStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  vehicleType: { type: String, trim: true, maxlength: 80, default: "" },
  isOnline: { type: Boolean, default: false, index: true },
  activeDeliveryId: { type: mongoose.Schema.Types.ObjectId, ref: "Delivery", default: null },
  lastOnlineAt: { type: Date, default: null },
}, { _id: false });

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  emailVerified: { type: Boolean, default: false, index: true },
  phone: { type: String, trim: true, default: "", maxlength: 32 },
  phoneVerified: { type: Boolean, default: false, index: true },
  firstName: { type: String, trim: true, required: true, maxlength: 60 },
  lastName: { type: String, trim: true, default: "", maxlength: 60 },
  passwordHash: { type: String, select: false },
  role: { type: String, enum: ["customer", "supermarket", "rider", "admin"], required: true, default: "customer", index: true },
  approvalStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "approved", index: true },
  isSuspended: { type: Boolean, default: false, index: true },
  suspensionReason: { type: String, trim: true, maxlength: 500, default: "" },
  suspendedAt: { type: Date, default: null },
  riderProfile: { type: riderProfileSchema, default: undefined },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

// The partial unique index preserves uncredentialed historical user records
// while enforcing unique normalized email addresses for password accounts.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { passwordHash: { $type: "string" } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phoneVerified: true, phone: { $type: "string", $gt: "" } } });

export const User = mongoose.models.User || mongoose.model("User", userSchema);
