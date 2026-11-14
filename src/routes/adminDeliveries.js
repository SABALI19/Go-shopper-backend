import { Router } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { Delivery } from "../models/Delivery.js";
import { ParentOrder } from "../models/ParentOrder.js";
import { SubOrder } from "../models/SubOrder.js";
import { Store } from "../models/Store.js";
import { User } from "../models/User.js";
import { AdminAudit } from "../models/AdminAudit.js";
import { OrderWorkflowError } from "../features/orders/service.js";

export function createAdminDeliveriesRouter({
  DeliveryModel = Delivery, ParentOrderModel = ParentOrder, SubOrderModel = SubOrder,
  StoreModel = Store, UserModel = User, AuditModel = AdminAudit,
  connection = mongoose.connection, authenticate = requireAuth,
  authorizeAdmin = requireRoles("admin"),
} = {}) {
  const router = Router();
  router.use(authenticate, authorizeAdmin);
  router.param("deliveryId", (req, res, next, id) => /^[a-f\d]{24}$/i.test(id) ? next() : res.status(404).json({ error: { code: "DELIVERY_NOT_FOUND", message: "Delivery not found." } }));

  router.get("/", asyncHandler(async (req, res) => {
    const { page, limit } = pagination(req.query);
    const filter = {};
    const status = req.query.status === "unassigned" ? "awaiting_assignment" : req.query.status;
    if (status && status !== "all") {
      if (!STATUSES.has(String(status))) throw new OrderWorkflowError(400, "INVALID_DELIVERY_STATUS", "Unknown delivery status.");
      filter.status = String(status);
    }
    if (req.query.q) {
      const q = escapeRegex(String(req.query.q).trim().slice(0, 80));
      filter.$or = [{ parentOrderNumber: new RegExp(q, "i") }, { subOrderNumber: new RegExp(q, "i") }, { storeName: new RegExp(q, "i") }];
      const riders = await UserModel.find({ role: "rider", $or: [{ firstName: new RegExp(q, "i") }, { lastName: new RegExp(q, "i") }, { phone: new RegExp(q, "i") }] }).select("_id").lean();
      if (riders.length) filter.$or.push({ assignedRiderUserId: { $in: riders.map((rider) => String(rider._id)) } });
    }
    const [rows, total] = await Promise.all([DeliveryModel.find(filter).sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), DeliveryModel.countDocuments(filter)]);
    const users = await UserModel.find({ _id: { $in: rows.map((row) => row.assignedRiderUserId).filter(Boolean) } }).select("_id firstName lastName phone role isSuspended riderProfile").lean();
    const byId = new Map(users.map((user) => [String(user._id), safeRider(user)]));
    return res.json({ deliveries: rows.map((row) => safeDelivery(row, byId.get(row.assignedRiderUserId))), page, limit, total });
  }));

  router.get("/:deliveryId", asyncHandler(async (req, res) => {
    const delivery = await DeliveryModel.findById(req.params.deliveryId).lean();
    if (!delivery) return res.status(404).json({ error: { code: "DELIVERY_NOT_FOUND", message: "Delivery not found." } });
    const rider = delivery.assignedRiderUserId ? await UserModel.findById(delivery.assignedRiderUserId).select("_id firstName lastName phone role isSuspended riderProfile").lean() : null;
    const priorRiderIds = [...new Set((delivery.assignmentHistory || []).map((entry) => entry.riderUserId).filter(Boolean))];
    const priorRiders = priorRiderIds.length ? await UserModel.find({ _id: { $in: priorRiderIds } }).select("_id firstName lastName phone").lean() : [];
    const priorRiderById = new Map(priorRiders.map((entry) => [String(entry._id), { firstName: entry.firstName || "", lastName: entry.lastName || "", phone: entry.phone || "" }]));
    return res.json({ delivery: { ...safeDelivery(delivery, rider ? safeRider(rider) : null), destination: delivery.destination, assignmentHistory: (delivery.assignmentHistory || []).map(({ riderUserId, action, reason, createdAt }) => ({ rider: priorRiderById.get(riderUserId) || null, action, reason, createdAt })), history: (delivery.history || []).map(({ actorRole, action, fromStatus, toStatus, reason, createdAt }) => ({ actorRole, action, fromStatus, toStatus, reason, createdAt })) } });
  }));

  router.get("/riders/list", asyncHandler(async (req, res) => {
    const filter = { role: "rider" };
    if (req.query.status === "approved") filter["riderProfile.approvalStatus"] = "approved";
    else if (req.query.status === "pending") filter["riderProfile.approvalStatus"] = "pending";
    else if (req.query.status === "rejected") filter["riderProfile.approvalStatus"] = "rejected";
    else if (req.query.status && req.query.status !== "all") throw new OrderWorkflowError(400, "INVALID_RIDER_STATUS", "Unknown rider status.");
    const riders = await UserModel.find(filter).select("firstName lastName email phone role isSuspended riderProfile createdAt").sort({ createdAt: -1 }).limit(200).lean();
    return res.json({ riders: riders.map((rider) => ({ id: String(rider._id), firstName: rider.firstName, lastName: rider.lastName, email: rider.email, phone: rider.phone, isSuspended: Boolean(rider.isSuspended), approvalStatus: rider.riderProfile?.approvalStatus || "pending", vehicleType: rider.riderProfile?.vehicleType || "", isOnline: Boolean(rider.riderProfile?.isOnline), hasActiveDelivery: Boolean(rider.riderProfile?.activeDeliveryId), createdAt: rider.createdAt })) });
  }));

  router.post("/riders/provision", asyncHandler(async (req, res) => {
    const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
    const vehicleType = typeof req.body?.vehicleType === "string" ? req.body.vehicleType.trim() : "";
    if (Object.keys(req.body || {}).some((key) => !["userId", "vehicleType"].includes(key)) || !/^[a-f\d]{24}$/i.test(userId) || vehicleType.length > 80) throw new OrderWorkflowError(400, "INVALID_RIDER_PROVISION", "Provide a valid Go-Shopper user ID and optional vehicle type (max 80 characters).");
    const user = await UserModel.findOne({ _id: userId, role: "rider", isSuspended: { $ne: true }, emailVerified: true, phoneVerified: true });
    if (!user) throw new OrderWorkflowError(404, "RIDER_ACCOUNT_NOT_FOUND", "A verified delivery partner account is required before provisioning.");
    if (user.riderProfile) throw new OrderWorkflowError(409, "RIDER_ALREADY_PROVISIONED", "This delivery partner already has a rider profile.");
    user.approvalStatus = "pending"; user.riderProfile = { approvalStatus: "pending", vehicleType, isOnline: false, activeDeliveryId: null }; await user.save();
    const auth = req.auth;
    await AuditModel.create({ actorUserId: auth.userId, action: "rider_account_provisioned", targetType: "user", targetId: String(user._id), metadata: { role: "rider" } });
    return res.status(201).json({ rider: { id: String(user._id), firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.phone, approvalStatus: user.riderProfile?.approvalStatus || "pending", vehicleType: user.riderProfile?.vehicleType || "", isOnline: false } });
  }));

  router.patch("/riders/:riderId/profile", asyncHandler(async (req, res) => {
    const allowed = ["approvalStatus", "vehicleType"];
    if (!Object.keys(req.body || {}).length || Object.keys(req.body).some((key) => !allowed.includes(key)) || (req.body.approvalStatus !== undefined && !["pending", "approved", "rejected"].includes(req.body.approvalStatus)) || (req.body.vehicleType !== undefined && (typeof req.body.vehicleType !== "string" || req.body.vehicleType.trim().length > 80))) throw new OrderWorkflowError(400, "INVALID_RIDER_PROFILE", "Only approvalStatus and vehicleType may be updated.");
    const rider = await UserModel.findOne({ _id: req.params.riderId, role: "rider" });
    if (!rider) return res.status(404).json({ error: { code: "RIDER_NOT_FOUND", message: "Rider not found." } });
    const update = {};
    if (req.body.approvalStatus !== undefined) update["riderProfile.approvalStatus"] = req.body.approvalStatus;
    if (req.body.vehicleType !== undefined) update["riderProfile.vehicleType"] = req.body.vehicleType.trim();
    if (req.body.approvalStatus !== "approved" && req.body.approvalStatus !== undefined) update["riderProfile.isOnline"] = false;
    rider.set(update); await rider.save();
    const auth = req.auth;
    await AuditModel.create({ actorUserId: auth.userId, action: "rider_profile_updated", targetType: "user", targetId: String(rider._id), metadata: { approvalStatus: rider.riderProfile?.approvalStatus, vehicleType: rider.riderProfile?.vehicleType } });
    return res.json({ rider: { id: String(rider._id), firstName: rider.firstName, lastName: rider.lastName, email: rider.email, phone: rider.phone, approvalStatus: rider.riderProfile?.approvalStatus, vehicleType: rider.riderProfile?.vehicleType, isOnline: rider.riderProfile?.isOnline } });
  }));

  router.post("/:deliveryId/assign", asyncHandler(async (req, res) => {
    if (Object.keys(req.body || {}).some((key) => !["riderUserId", "reason"].includes(key)) || typeof req.body?.riderUserId !== "string" || !/^[a-f\d]{24}$/i.test(req.body.riderUserId) || (req.body.reason !== undefined && (typeof req.body.reason !== "string" || req.body.reason.trim().length > 500))) throw new OrderWorkflowError(400, "INVALID_ASSIGNMENT", "riderUserId and an optional reason of at most 500 characters are required.");
    const auth = req.auth; const reason = req.body.reason?.trim() || "";
    const session = await connection.startSession(); let result;
    try {
      await session.withTransaction(async () => {
        const delivery = await DeliveryModel.findById(req.params.deliveryId).session(session).lean();
        if (!delivery) throw new OrderWorkflowError(404, "DELIVERY_NOT_FOUND", "Delivery not found.");
        if (!["awaiting_assignment", "failed", "assigned", "accepted", "arrived_at_pickup"].includes(delivery.status)) throw new OrderWorkflowError(409, "DELIVERY_NOT_REASSIGNABLE", "This delivery cannot be assigned again after the order has entered transit.");
        const rider = await UserModel.findOne({ _id: req.body.riderUserId, role: "rider", isSuspended: { $ne: true }, "riderProfile.approvalStatus": "approved", "riderProfile.isOnline": true, "riderProfile.activeDeliveryId": null }).session(session).lean();
        if (!rider) throw new OrderWorkflowError(409, "RIDER_UNAVAILABLE", "Choose an approved, active rider who is online and has no active delivery.");
        const parent = await ParentOrderModel.findOne({ _id: delivery.parentOrderId, paymentStatus: "paid" }).session(session).lean();
        const eligibleChildStatuses = delivery.pickedUpAt ? ["dispatched"] : ["ready_for_dispatch"];
        const child = await SubOrderModel.findOne({ _id: delivery.subOrderId, storeId: delivery.storeId, status: { $in: eligibleChildStatuses } }).session(session).lean();
        const store = await StoreModel.findOne({ _id: delivery.storeId, isActive: true, isApproved: true, approvalStatus: "approved" }).session(session).lean();
        if (!parent || !child || !store) throw new OrderWorkflowError(409, "DELIVERY_NOT_ELIGIBLE", "Only paid orders from an active, approved store can be assigned.");
        const claim = await UserModel.updateOne({ _id: rider._id, role: "rider", isSuspended: { $ne: true }, "riderProfile.approvalStatus": "approved", "riderProfile.isOnline": true, "riderProfile.activeDeliveryId": null }, { $set: { "riderProfile.activeDeliveryId": delivery._id, "riderProfile.isOnline": false } }, { session });
        if ((claim.modifiedCount ?? claim.nModified) !== 1) throw new OrderWorkflowError(409, "RIDER_ALREADY_ASSIGNED", "That rider has just become unavailable. Choose another rider.");
        if (delivery.assignedRiderUserId && delivery.assignedRiderUserId !== String(rider._id)) await UserModel.updateOne({ _id: delivery.assignedRiderUserId, "riderProfile.activeDeliveryId": delivery._id }, { $set: { "riderProfile.activeDeliveryId": null } }, { session });
        const now = new Date(); const reassigned = Boolean(delivery.assignedRiderUserId);
        result = await DeliveryModel.findOneAndUpdate({ _id: delivery._id, status: delivery.status }, { $set: { assignedRiderUserId: String(rider._id), status: "assigned", assignedAt: now, acceptedAt: null, arrivedAt: null, failedAt: null, failureReason: "", "proofOfDelivery.codeHash": "", "proofOfDelivery.codeExpiresAt": null, "proofOfDelivery.codeAttempts": 0, "proofOfDelivery.codeIssueCount": 0 }, $push: { assignmentHistory: { actorUserId: auth.userId, riderUserId: String(rider._id), action: reassigned ? "reassigned" : "assigned", reason, createdAt: now }, history: { actorUserId: auth.userId, actorRole: "admin", action: reassigned ? "admin_reassigned_rider" : "admin_assigned_rider", fromStatus: delivery.status, toStatus: "assigned", reason, createdAt: now } } }, { new: true, session, runValidators: true }).lean();
        if (!result) throw new OrderWorkflowError(409, "DELIVERY_CHANGED", "Delivery changed while assigning. Refresh and try again.");
        await AuditModel.create([{ actorUserId: auth.userId, action: reassigned ? "delivery_rider_reassigned" : "delivery_rider_assigned", targetType: "delivery", targetId: String(delivery._id), reason, metadata: { riderUserId: String(rider._id), orderNumber: delivery.parentOrderNumber } }], { session });
      });
    } finally { await session.endSession(); }
    return res.json({ delivery: safeDelivery(result, await findSafeRider(UserModel, result.assignedRiderUserId)) });
  }));

  return router;
}

const STATUSES = new Set(["awaiting_assignment", "assigned", "accepted", "arrived_at_pickup", "picked_up", "in_transit", "delivered", "failed"]);
function safeDelivery(d, rider) { return { id: String(d._id), parentOrderNumber: d.parentOrderNumber, subOrderNumber: d.subOrderNumber, storeId: d.storeSlug, storeName: d.storeName, status: d.status, assignedAt: d.assignedAt, arrivedAt: d.arrivedAt, pickedUpAt: d.pickedUpAt, dispatchedAt: d.dispatchedAt, deliveredAt: d.deliveredAt, failedAt: d.failedAt, failureReason: d.failureReason || "", deliveryNotes: d.deliveryNotes || "", proofVerifiedAt: d.proofOfDelivery?.codeVerifiedAt || null, rider: rider || null, createdAt: d.createdAt, updatedAt: d.updatedAt }; }
function safeRider(user) { return { firstName: user.firstName || "", lastName: user.lastName || "", phone: user.phone || "", vehicleType: user.riderProfile?.vehicleType || "", approvalStatus: user.riderProfile?.approvalStatus || "pending", isOnline: Boolean(user.riderProfile?.isOnline), isSuspended: Boolean(user.isSuspended) }; }
async function findSafeRider(UserModel, userId) { const user = await UserModel.findById(userId).select("firstName lastName phone role isSuspended riderProfile").lean(); return user ? safeRider(user) : null; }
function pagination(query) { const page = query.page === undefined ? 1 : Number(query.page); const limit = query.limit === undefined ? 25 : Number(query.limit); if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100."); return { page, limit }; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
