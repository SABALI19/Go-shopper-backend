import mongoose from "mongoose";

const riderProfileSchema = new mongoose.Schema({
  approvalStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
  vehicleType: { type: String, trim: true, maxlength: 80, default: "" },
  isOnline: { type: Boolean, default: false, index: true },
  activeDeliveryId: { type: mongoose.Schema.Types.ObjectId, ref: "Delivery", default: null },
  lastOnlineAt: { type: Date, default: null },
}, { _id: false });

const userSchema = new mongoose.Schema({
  clerkUserId: { type: String, required: true, unique: true, index: true },
  email: { type: String, trim: true, lowercase: true, default: "" },
  phone: { type: String, trim: true, default: "" },
  firstName: { type: String, trim: true, default: "" },
  lastName: { type: String, trim: true, default: "" },
  role: { type: String, enum: ["customer", "supermarket", "rider", "admin"], default: "customer", index: true },
  riderProfile: { type: riderProfileSchema, default: undefined },
  isSuspended: { type: Boolean, default: false, index: true },
  suspensionReason: { type: String, trim: true, maxlength: 500, default: "" },
  suspendedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

export const User = mongoose.model("User", userSchema);
