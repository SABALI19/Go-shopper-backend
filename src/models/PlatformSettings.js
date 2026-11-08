import mongoose from "mongoose";

const platformSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: "platform" },
  minimumStoreSubtotalKobo: { type: Number, required: true, min: 1, max: 1_000_000_000, validate: Number.isSafeInteger },
  deliveryFeeKobo: { type: Number, required: true, min: 0, max: 1_000_000_000, validate: Number.isSafeInteger },
  serviceFeeKobo: { type: Number, required: true, min: 0, max: 1_000_000_000, validate: Number.isSafeInteger },
  updatedBy: { type: String, required: true },
}, { timestamps: true, versionKey: false });

export const PlatformSettings = mongoose.model("PlatformSettings", platformSettingsSchema);
