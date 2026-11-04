import mongoose from "mongoose";

const productSchema = new mongoose.Schema({
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true, index: true },
  productKey: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, trim: true, maxlength: 3000, default: "" },
  category: { type: String, trim: true, maxlength: 80, default: "" },
  imageUrl: { type: String, trim: true, default: "" },
  priceKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  stockQuantity: { type: Number, required: true, min: 0, default: 0, validate: Number.isSafeInteger },
  isAvailable: { type: Boolean, default: true, index: true },
}, { timestamps: true, versionKey: false });

productSchema.index({ storeId: 1, productKey: 1 }, { unique: true });
productSchema.index({ storeId: 1, category: 1, isAvailable: 1 });

export const Product = mongoose.model("Product", productSchema);
