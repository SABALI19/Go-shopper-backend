import mongoose from "mongoose";

const orderItemSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
  productKey: { type: String, required: true },
  productName: { type: String, required: true },
  unitPriceKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  quantity: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
  lineTotalKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  fulfilmentStatus: { type: String, enum: ["pending", "preparing", "unavailable", "fulfilled"], default: "pending" },
  refundAmountKobo: { type: Number, min: 0, default: 0, validate: Number.isSafeInteger },
  refundStatus: { type: String, enum: ["not_applicable", "pending"], default: "not_applicable" },
  unavailableReason: { type: String, trim: true, maxlength: 500, default: "" },
  unavailableAt: { type: Date, default: null },
  reservationStatus: { type: String, enum: ["held", "released", "consumed"], default: "held" },
  auditEvents: { type: [mongoose.Schema.Types.Mixed], default: [] },
}, { _id: false });

const cancellationSchema = new mongoose.Schema({
  reason: { type: String, trim: true, maxlength: 500, default: "" },
  cancelledAt: { type: Date, default: null },
  cancelledBy: { type: String, enum: ["customer", "admin", "system", null], default: null },
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

const subOrderSchema = new mongoose.Schema({
  subOrderNumber: { type: String, required: true, unique: true, index: true },
  parentOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "ParentOrder", required: true, index: true },
  parentOrderNumber: { type: String, required: true },
  customerUserId: { type: String, required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true, index: true },
  storeSlug: { type: String, required: true },
  storeName: { type: String, required: true },
  items: { type: [orderItemSchema], required: true, validate: (items) => items.length > 0 },
  merchandiseSubtotalKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  deliveryFeeKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  serviceFeeKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  totalKobo: { type: Number, required: true, min: 0, validate: Number.isSafeInteger },
  fulfilmentSubtotalKobo: { type: Number, min: 0, validate: Number.isSafeInteger },
  status: {
    type: String,
    enum: ["pending_payment", "pending_fulfilment", "accepted", "preparing", "ready_for_dispatch", "dispatched", "delivered", "unable_to_fulfil", "customer_action_required", "cancelled"],
    default: "pending_payment",
    index: true,
  },
  reservationStatus: { type: String, enum: ["held", "released", "consumed"], default: "held", index: true },
  reservationReleasedAt: { type: Date, default: null },
  cancellation: { type: cancellationSchema, default: () => ({}) },
  customerAction: { type: customerActionSchema, default: () => ({}) },
}, { timestamps: true, versionKey: false });

subOrderSchema.index({ storeId: 1, status: 1, createdAt: -1 });
subOrderSchema.index({ customerUserId: 1, createdAt: -1 });
subOrderSchema.index({ parentOrderId: 1, storeId: 1 });

export const SubOrder = mongoose.model("SubOrder", subOrderSchema);
