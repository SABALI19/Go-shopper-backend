import mongoose from "mongoose";

const deliverySchema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 120 },
  address: { type: String, required: true, trim: true, maxlength: 500 },
  phone: { type: String, required: true, trim: true, maxlength: 32 },
}, { _id: false });

const customerActionSchema = new mongoose.Schema({
  reason: { type: String, trim: true, maxlength: 500, default: "" },
  affectedSubOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "SubOrder", default: null },
  affectedStoreId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", default: null },
  affectedStoreName: { type: String, trim: true, default: "" },
  amountKobo: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
  requestedAt: { type: Date, default: null },
  decision: { type: String, enum: ["pending", "proceed_remaining", "cancel_remaining", null], default: null },
  decidedAt: { type: Date, default: null },
}, { _id: false });

const refundObligationSchema = new mongoose.Schema({
  key: { type: String, required: true },
  kind: { type: String, enum: ["item_unavailable", "store_cancelled", "parent_cancelled"], required: true },
  subOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "SubOrder", required: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true },
  storeName: { type: String, required: true },
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", default: null },
  productKey: { type: String, default: "" },
  productName: { type: String, default: "" },
  amountKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  status: { type: String, enum: ["pending"], default: "pending" },
  reason: { type: String, trim: true, maxlength: 500, required: true },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const parentOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, required: true, unique: true, index: true },
  customerClerkUserId: { type: String, required: true, index: true },
  idempotencyKey: { type: String, required: true },
  requestFingerprint: { type: String, required: true },
  subOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "SubOrder" }],
  delivery: { type: deliverySchema, required: true },
  merchandiseSubtotalKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  deliveryFeeKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  serviceFeeKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  totalKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  minimumStoreSubtotalKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  status: {
    type: String,
    enum: ["pending_payment", "confirmed", "processing", "partially_fulfilled", "completed", "cancelled", "customer_action_required"],
    default: "pending_payment",
    index: true,
  },
  paymentStatus: { type: String, enum: ["pending", "paid", "failed", "refunded"], default: "pending", index: true },
  reservationStatus: { type: String, enum: ["held", "released", "consumed"], default: "held", index: true },
  reservationExpiresAt: { type: Date, required: true, index: true },
  reservationReleasedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  cancellationReason: { type: String, trim: true, maxlength: 500, default: "" },
  customerAction: { type: customerActionSchema, default: () => ({}) },
  customerActionHistory: { type: [mongoose.Schema.Types.Mixed], default: [] },
  refundObligations: { type: [refundObligationSchema], default: [] },
}, { timestamps: true, versionKey: false });

parentOrderSchema.index({ customerClerkUserId: 1, createdAt: -1 });
parentOrderSchema.index({ customerClerkUserId: 1, idempotencyKey: 1 }, { unique: true });
parentOrderSchema.index({ reservationStatus: 1, reservationExpiresAt: 1, paymentStatus: 1 });

export const ParentOrder = mongoose.model("ParentOrder", parentOrderSchema);
