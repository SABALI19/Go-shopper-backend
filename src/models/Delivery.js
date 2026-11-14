import mongoose from "mongoose";

const deliveryEventSchema = new mongoose.Schema({
  actorUserId: { type: String, required: true },
  actorRole: { type: String, enum: ["admin", "rider", "supermarket", "system"], required: true },
  action: { type: String, required: true, trim: true, maxlength: 80 },
  fromStatus: { type: String, default: "" },
  toStatus: { type: String, default: "" },
  reason: { type: String, trim: true, maxlength: 500, default: "" },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const assignmentEventSchema = new mongoose.Schema({
  actorUserId: { type: String, required: true },
  riderUserId: { type: String, required: true },
  action: { type: String, enum: ["assigned", "reassigned"], required: true },
  reason: { type: String, trim: true, maxlength: 500, default: "" },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const deliverySchema = new mongoose.Schema({
  parentOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "ParentOrder", required: true, index: true },
  parentOrderNumber: { type: String, required: true, index: true },
  subOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "SubOrder", required: true, unique: true, index: true },
  subOrderNumber: { type: String, required: true, index: true },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: "Store", required: true, index: true },
  storeSlug: { type: String, required: true },
  storeName: { type: String, required: true },
  customerUserId: { type: String, required: true, index: true },
  destination: {
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    address: { type: String, required: true, trim: true, maxlength: 500 },
    phone: { type: String, required: true, trim: true, maxlength: 32 },
  },
  assignedRiderUserId: { type: String, default: null, index: true },
  status: {
    type: String,
    enum: ["awaiting_assignment", "assigned", "accepted", "arrived_at_pickup", "picked_up", "in_transit", "delivered", "failed"],
    default: "awaiting_assignment",
    index: true,
  },
  assignedAt: { type: Date, default: null },
  acceptedAt: { type: Date, default: null },
  arrivedAt: { type: Date, default: null },
  pickedUpAt: { type: Date, default: null },
  dispatchedAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  failureReason: { type: String, trim: true, maxlength: 500, default: "" },
  deliveryNotes: { type: String, trim: true, maxlength: 500, default: "" },
  proofOfDelivery: {
    codeHash: { type: String, default: "" },
    codeExpiresAt: { type: Date, default: null },
    codeAttempts: { type: Number, min: 0, default: 0 },
    codeIssuedAt: { type: Date, default: null },
    codeIssueCount: { type: Number, min: 0, default: 0 },
    codeVerifiedAt: { type: Date, default: null },
  },
  assignmentHistory: { type: [assignmentEventSchema], default: [] },
  history: { type: [deliveryEventSchema], default: [] },
}, { timestamps: true, versionKey: false });

deliverySchema.index({ assignedRiderUserId: 1, status: 1, updatedAt: -1 });
deliverySchema.index({ storeId: 1, status: 1, updatedAt: -1 });
deliverySchema.index({ customerUserId: 1, createdAt: -1 });

export const Delivery = mongoose.model("Delivery", deliverySchema);
