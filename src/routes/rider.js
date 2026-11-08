import { Router } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import mongoose from "mongoose";
import { getAuth } from "@clerk/express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getUserRole, requireAuth, requireRoles } from "../middleware/auth.js";
import { OrderWorkflowError, deriveParentOrderStatus, isValidParentOrderTransition, isValidSubOrderTransition } from "../features/orders/service.js";
import { ACTIVE_RIDER_DELIVERY_STATUSES, isValidDeliveryTransition, publicDelivery } from "../features/deliveries/rules.js";
import { Delivery } from "../models/Delivery.js";
import { ParentOrder } from "../models/ParentOrder.js";
import { SubOrder } from "../models/SubOrder.js";
import { User } from "../models/User.js";

export function createRiderRouter({
  DeliveryModel = Delivery, ParentOrderModel = ParentOrder, SubOrderModel = SubOrder,
  UserModel = User, connection = mongoose.connection, authenticate = requireAuth,
  authorizeRider = requireRoles("rider"), roleProvider = getUserRole,
} = {}) {
  const router = Router();
  router.use(authenticate, authorizeRider);
  router.param("deliveryId", (req, res, next, id) => /^[a-f\d]{24}$/i.test(id) ? next() : res.status(404).json({ error: { code: "DELIVERY_NOT_FOUND", message: "Delivery not found." } }));

  router.get("/profile", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req);
    const rider = await findRider(UserModel, auth.userId);
    if (!rider) return res.status(403).json({ error: { code: "RIDER_PROFILE_REQUIRED", message: "This rider account is not ready." } });
    const activeDelivery = rider.riderProfile?.activeDeliveryId
      ? await DeliveryModel.findById(rider.riderProfile.activeDeliveryId).select("_id parentOrderNumber subOrderNumber storeName status").lean()
      : null;
    const [activeCount, completedCount, assignedCount] = await Promise.all([
      DeliveryModel.countDocuments({ assignedRiderClerkUserId: auth.userId, status: { $in: ACTIVE_RIDER_DELIVERY_STATUSES } }),
      DeliveryModel.countDocuments({ assignedRiderClerkUserId: auth.userId, status: "delivered" }),
      DeliveryModel.countDocuments({ assignedRiderClerkUserId: auth.userId, status: "assigned" }),
    ]);
    return res.json({ profile: safeRider(rider), activeDelivery: activeDelivery ? safeDeliverySummary(activeDelivery) : null, summary: { activeCount, completedCount, assignedCount } });
  }));

  router.patch("/availability", asyncHandler(async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== "isOnline") || typeof req.body.isOnline !== "boolean") {
      throw new OrderWorkflowError(400, "INVALID_AVAILABILITY", "isOnline must be true or false.");
    }
    const auth = req.auth || getAuth(req);
    const rider = await findRider(UserModel, auth.userId);
    if (!rider) return res.status(403).json({ error: { code: "RIDER_PROFILE_REQUIRED", message: "This rider account is not ready." } });
    if (req.body.isOnline && rider.riderProfile?.approvalStatus !== "approved") {
      throw new OrderWorkflowError(403, "RIDER_NOT_APPROVED", "Only approved riders can go online.");
    }
    if (req.body.isOnline && rider.riderProfile?.activeDeliveryId) {
      throw new OrderWorkflowError(409, "RIDER_HAS_ACTIVE_DELIVERY", "Complete or report your active delivery before going online.");
    }
    const updated = await UserModel.findOneAndUpdate(
      { clerkUserId: auth.userId, role: "rider", isSuspended: { $ne: true }, ...(req.body.isOnline ? { "riderProfile.approvalStatus": "approved", "riderProfile.activeDeliveryId": null } : {}) },
      { $set: { "riderProfile.isOnline": req.body.isOnline, "riderProfile.lastOnlineAt": req.body.isOnline ? new Date() : rider.riderProfile?.lastOnlineAt ?? null } },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) throw new OrderWorkflowError(409, "AVAILABILITY_CHANGED", "Rider status changed. Refresh and try again.");
    return res.json({ profile: safeRider(updated) });
  }));

  router.get("/deliveries", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req);
    const { page, limit } = pagination(req.query);
    const filter = { assignedRiderClerkUserId: auth.userId };
    if (req.query.status) {
      if (!DELIVERY_STATUSES.has(String(req.query.status))) throw new OrderWorkflowError(400, "INVALID_DELIVERY_STATUS", "Unknown delivery status.");
      filter.status = String(req.query.status);
    }
    const [deliveries, total] = await Promise.all([
      DeliveryModel.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      DeliveryModel.countDocuments(filter),
    ]);
    return res.json({ deliveries: deliveries.map((delivery) => ({ ...publicDelivery(delivery), destination: delivery.destination })), page, limit, total });
  }));

  router.get("/deliveries/:deliveryId", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req);
    const delivery = await DeliveryModel.findOne({ _id: req.params.deliveryId, assignedRiderClerkUserId: auth.userId }).lean();
    if (!delivery) return res.status(404).json({ error: { code: "DELIVERY_NOT_FOUND", message: "Delivery not found for this rider." } });
    return res.json({ delivery: { ...publicDelivery(delivery), destination: delivery.destination } });
  }));

  router.post("/deliveries/:deliveryId/accept", asyncHandler(async (req, res) => {
    return applyRiderTransition({ req, res, to: "accepted", action: "rider_accepted", DeliveryModel, UserModel, ParentOrderModel, SubOrderModel, connection, roleProvider });
  }));
  router.post("/deliveries/:deliveryId/arrive", asyncHandler(async (req, res) => {
    return applyRiderTransition({ req, res, to: "arrived_at_pickup", action: "rider_arrived_at_pickup", DeliveryModel, UserModel, ParentOrderModel, SubOrderModel, connection, roleProvider });
  }));
  router.post("/deliveries/:deliveryId/in-transit", asyncHandler(async (req, res) => {
    return applyRiderTransition({ req, res, to: "in_transit", action: "rider_started_delivery", DeliveryModel, UserModel, ParentOrderModel, SubOrderModel, connection, roleProvider });
  }));
  router.post("/deliveries/:deliveryId/fail", asyncHandler(async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== "reason") || typeof req.body.reason !== "string" || !req.body.reason.trim() || req.body.reason.trim().length > 500) {
      throw new OrderWorkflowError(400, "INVALID_FAILURE_REASON", "A delivery failure reason of at most 500 characters is required.");
    }
    return applyRiderTransition({ req, res, to: "failed", action: "rider_reported_failure", reason: req.body.reason.trim(), DeliveryModel, UserModel, ParentOrderModel, SubOrderModel, connection, roleProvider });
  }));
  router.post("/deliveries/:deliveryId/complete", asyncHandler(async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => !["code", "deliveryNotes"].includes(key)) || typeof req.body.code !== "string" || !/^\d{6}$/.test(req.body.code) || (req.body.deliveryNotes !== undefined && (typeof req.body.deliveryNotes !== "string" || req.body.deliveryNotes.trim().length > 500))) {
      throw new OrderWorkflowError(400, "INVALID_DELIVERY_PROOF", "A six-digit customer delivery code is required; notes are optional and limited to 500 characters.");
    }
    const auth = req.auth || getAuth(req);
    const delivery = await DeliveryModel.findOne({ _id: req.params.deliveryId, assignedRiderClerkUserId: auth.userId }).lean();
    if (!delivery) return res.status(404).json({ error: { code: "DELIVERY_NOT_FOUND", message: "Delivery not found for this rider." } });
    if (delivery.status !== "in_transit") throw new OrderWorkflowError(409, "INVALID_DELIVERY_TRANSITION", "Only an in-transit delivery can be completed.");
    const proof = delivery.proofOfDelivery || {};
    if (!proof.codeHash || !proof.codeExpiresAt || new Date(proof.codeExpiresAt) <= new Date()) throw new OrderWorkflowError(409, "DELIVERY_CODE_EXPIRED", "Ask the customer to create a new delivery code.");
    if ((proof.codeAttempts || 0) >= MAX_CODE_ATTEMPTS) throw new OrderWorkflowError(429, "DELIVERY_CODE_LOCKED", "Too many code attempts. Ask the customer to issue a new code.");
    const suppliedHash = hashCode(req.body.code);
    const valid = safeHashEquals(suppliedHash, proof.codeHash);
    if (!valid) {
      await DeliveryModel.updateOne({ _id: delivery._id, assignedRiderClerkUserId: auth.userId, status: "in_transit", "proofOfDelivery.codeAttempts": proof.codeAttempts || 0 }, { $inc: { "proofOfDelivery.codeAttempts": 1 } });
      throw new OrderWorkflowError(400, "INVALID_DELIVERY_CODE", "The delivery code is incorrect.");
    }
    const completed = await completeDelivery({ delivery, expectedCodeHash: suppliedHash, riderClerkUserId: auth.userId, deliveryNotes: req.body.deliveryNotes?.trim() || "", DeliveryModel, UserModel, ParentOrderModel, SubOrderModel, connection });
    return res.json({ delivery: publicDelivery(completed) });
  }));

  return router;
}

async function applyRiderTransition({ req, res, to, action, reason = "", DeliveryModel, UserModel, ParentOrderModel, SubOrderModel, connection, roleProvider }) {
  const auth = req.auth || getAuth(req);
  if (await roleProvider(auth) !== "rider") throw new OrderWorkflowError(403, "RIDER_REQUIRED", "Rider access is required.");
  const rider = await findRider(UserModel, auth.userId);
  if (!rider || rider.riderProfile?.approvalStatus !== "approved") throw new OrderWorkflowError(403, "RIDER_NOT_APPROVED", "Only approved riders can perform delivery actions.");
  const result = await withTransaction(connection, async (session) => {
    const delivery = await DeliveryModel.findOne({ _id: req.params.deliveryId, assignedRiderClerkUserId: auth.userId }).session(session).lean();
    if (!delivery) throw new OrderWorkflowError(404, "DELIVERY_NOT_FOUND", "Delivery not found for this rider.");
    if (!isValidDeliveryTransition(delivery.status, to)) throw new OrderWorkflowError(409, "INVALID_DELIVERY_TRANSITION", `Cannot move a delivery from ${delivery.status} to ${to}.`);
    const parent = await ParentOrderModel.findById(delivery.parentOrderId).session(session).lean();
    const child = await SubOrderModel.findById(delivery.subOrderId).session(session).lean();
    if (!parent || !child || parent.paymentStatus !== "paid" || ["cancelled", "unable_to_fulfil", "customer_action_required"].includes(child.status)) {
      throw new OrderWorkflowError(409, "DELIVERY_NOT_ELIGIBLE", "This order is no longer eligible for delivery.");
    }
    if (to === "in_transit" && (!delivery.pickedUpAt || child.status !== "dispatched")) throw new OrderWorkflowError(409, "PICKUP_NOT_CONFIRMED", "The supermarket must confirm handover before the delivery can start.");
    const now = new Date();
    const timestamps = to === "accepted" ? { acceptedAt: now } : to === "arrived_at_pickup" ? { arrivedAt: now } : to === "in_transit" ? { dispatchedAt: now } : to === "failed" ? { failedAt: now, failureReason: reason } : {};
    const updated = await DeliveryModel.findOneAndUpdate(
      { _id: delivery._id, assignedRiderClerkUserId: auth.userId, status: delivery.status },
      { $set: { status: to, ...timestamps }, $push: { history: historyEvent(auth.userId, "rider", action, delivery.status, to, reason) } },
      { new: true, session, runValidators: true },
    ).lean();
    if (!updated) throw new OrderWorkflowError(409, "DELIVERY_CHANGED", "Delivery status changed. Refresh and try again.");
    if (to === "failed") await UserModel.updateOne({ clerkUserId: auth.userId, "riderProfile.activeDeliveryId": delivery._id }, { $set: { "riderProfile.activeDeliveryId": null, "riderProfile.isOnline": false } }, { session });
    return updated;
  });
  return res.json({ delivery: publicDelivery(result) });
}

async function completeDelivery({ delivery, expectedCodeHash, riderClerkUserId, deliveryNotes, DeliveryModel, UserModel, ParentOrderModel, SubOrderModel, connection }) {
  return withTransaction(connection, async (session) => {
    const current = await DeliveryModel.findOne({ _id: delivery._id, assignedRiderClerkUserId: riderClerkUserId, status: "in_transit" }).session(session).lean();
    if (!current) throw new OrderWorkflowError(409, "DELIVERY_CHANGED", "Delivery status changed. Refresh and try again.");
    const parent = await ParentOrderModel.findById(current.parentOrderId).session(session).lean();
    const child = await SubOrderModel.findById(current.subOrderId).session(session).lean();
    if (!parent || !child || parent.paymentStatus !== "paid" || child.status !== "dispatched") throw new OrderWorkflowError(409, "DELIVERY_NOT_ELIGIBLE", "This order is not eligible for completion.");
    const proof = current.proofOfDelivery || {};
    if (!safeHashEquals(expectedCodeHash, proof.codeHash) || !proof.codeExpiresAt || new Date(proof.codeExpiresAt) <= new Date() || (proof.codeAttempts || 0) >= MAX_CODE_ATTEMPTS) throw new OrderWorkflowError(409, "DELIVERY_CODE_CHANGED", "The delivery code expired or changed. Ask the customer for a current code.");
    if (!isValidSubOrderTransition(child.status, "delivered")) throw new OrderWorkflowError(409, "INVALID_ORDER_TRANSITION", "The store order cannot be completed from its current status.");
    const now = new Date();
    const updatedDelivery = await DeliveryModel.findOneAndUpdate(
      { _id: current._id, assignedRiderClerkUserId: riderClerkUserId, status: "in_transit", "proofOfDelivery.codeVerifiedAt": null },
      { $set: { status: "delivered", deliveredAt: now, deliveryNotes, "proofOfDelivery.codeVerifiedAt": now, "proofOfDelivery.codeHash": "" }, $push: { history: historyEvent(riderClerkUserId, "rider", "rider_completed_delivery", "in_transit", "delivered") } },
      { new: true, session, runValidators: true },
    ).lean();
    if (!updatedDelivery) throw new OrderWorkflowError(409, "DELIVERY_ALREADY_COMPLETED", "This delivery was already completed.");
    const updatedChild = await SubOrderModel.findOneAndUpdate({ _id: child._id, status: "dispatched" }, { $set: { status: "delivered", reservationStatus: "consumed" } }, { new: true, session, runValidators: true }).lean();
    if (!updatedChild) throw new OrderWorkflowError(409, "ORDER_CHANGED", "The store order changed. Refresh and try again.");
    const children = await SubOrderModel.find({ parentOrderId: parent._id }).session(session).select("status").lean();
    const parentStatus = deriveParentOrderStatus(parent.paymentStatus, children.map((entry) => entry.status));
    if (parentStatus !== parent.status && !isValidParentOrderTransition(parent.status, parentStatus)) throw new OrderWorkflowError(409, "INVALID_PARENT_STATUS_TRANSITION", `Cannot move parent order from ${parent.status} to ${parentStatus}.`);
    if (parentStatus !== parent.status) await ParentOrderModel.updateOne({ _id: parent._id, paymentStatus: "paid" }, { $set: { status: parentStatus } }, { session });
    await UserModel.updateOne({ clerkUserId: riderClerkUserId, "riderProfile.activeDeliveryId": current._id }, { $set: { "riderProfile.activeDeliveryId": null, "riderProfile.isOnline": false } }, { session });
    return updatedDelivery;
  });
}

async function withTransaction(connection, callback) {
  if (!connection?.startSession) throw new OrderWorkflowError(503, "TRANSACTION_UNAVAILABLE", "Delivery updates are temporarily unavailable.");
  const session = await connection.startSession();
  try {
    let value;
    await session.withTransaction(async () => { value = await callback(session); });
    return value;
  } finally { await session.endSession(); }
}

async function findRider(UserModel, clerkUserId) {
  return UserModel.findOne({ clerkUserId, role: "rider" }).select("clerkUserId firstName lastName email phone role isSuspended riderProfile").lean();
}
function safeRider(user) { return { firstName: user.firstName || "", lastName: user.lastName || "", phone: user.phone || "", vehicleType: user.riderProfile?.vehicleType || "", approvalStatus: user.riderProfile?.approvalStatus || "pending", isOnline: Boolean(user.riderProfile?.isOnline), isSuspended: Boolean(user.isSuspended) }; }
function safeDeliverySummary(delivery) { return { id: String(delivery._id), parentOrderNumber: delivery.parentOrderNumber, subOrderNumber: delivery.subOrderNumber, storeName: delivery.storeName, status: delivery.status }; }
function historyEvent(actorClerkUserId, actorRole, action, fromStatus, toStatus, reason = "") { return { actorClerkUserId, actorRole, action, fromStatus, toStatus, reason, createdAt: new Date() }; }
function hashCode(code) { return createHash("sha256").update(code).digest("hex"); }
function safeHashEquals(left, right) { if (typeof right !== "string" || !/^[a-f\d]{64}$/i.test(right)) return false; const a = Buffer.from(left, "hex"); const b = Buffer.from(right, "hex"); return a.length === b.length && timingSafeEqual(a, b); }
function pagination(query) { const page = query.page === undefined ? 1 : Number(query.page); const limit = query.limit === undefined ? 20 : Number(query.limit); if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100."); return { page, limit }; }
const DELIVERY_STATUSES = new Set(["awaiting_assignment", "assigned", "accepted", "arrived_at_pickup", "picked_up", "in_transit", "delivered", "failed"]);
const MAX_CODE_ATTEMPTS = 5;

export const deliveryHelpers = { hashCode, safeHashEquals, isValidDeliveryTransition, ACTIVE_RIDER_DELIVERY_STATUSES };
