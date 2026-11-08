import mongoose from "mongoose";

const storeSchema = new mongoose.Schema({
  ownerClerkUserId: { type: String, required: true, index: true },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
  category: { type: String, required: true, trim: true, maxlength: 80 },
  tagline: { type: String, trim: true, maxlength: 180, default: "" },
  description: { type: String, trim: true, maxlength: 3000, default: "" },
  logoUrl: { type: String, trim: true, default: "" },
  coverImageUrl: { type: String, trim: true, default: "" },
  rating: { type: Number, min: 0, max: 5, default: 0 },
  categories: { type: [String], default: [] },
  brandValues: { type: [String], default: [] },
  address: {
    line1: { type: String, trim: true, default: "" },
    city: { type: String, trim: true, default: "" },
    state: { type: String, trim: true, default: "" },
    country: { type: String, trim: true, default: "Nigeria" },
    location: { type: { type: String, enum: ["Point"] }, coordinates: { type: [Number] } },
  },
  openHours: { type: String, trim: true, default: "" },
  isActive: { type: Boolean, default: true, index: true },
  isApproved: { type: Boolean, default: false, index: true },
  approvalStatus: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
  approvalReason: { type: String, trim: true, maxlength: 500, default: "" },
  suspensionReason: { type: String, trim: true, maxlength: 500, default: "" },
  suspendedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

storeSchema.index({ "address.location": "2dsphere" }, { sparse: true });
storeSchema.index({ isActive: 1, isApproved: 1, category: 1 });
storeSchema.index({ name: "text", category: "text", tagline: "text" });

export const Store = mongoose.model("Store", storeSchema);
