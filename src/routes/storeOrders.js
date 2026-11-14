import { Router } from "express";
import mongoose from "mongoose";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { getUserRole, requireAuth, requireRoles } from "../middleware/auth.js";
import { storeLookup } from "../features/checkout/resolveCart.js";
import {
  deriveParentOrderStatus,
  isValidParentOrderTransition,
  isValidSubOrderTransition,
  OrderWorkflowError,
} from "../features/orders/service.js";
import { ParentOrder } from "../models/ParentOrder.js";
import { Product } from "../models/Product.js";
import { Store } from "../models/Store.js";
import { SubOrder } from "../models/SubOrder.js";
import { Delivery } from "../models/Delivery.js";
import { User } from "../models/User.js";
import { reportUnavailableItem, requestStoreCannotFulfil } from "../features/orders/exceptions.js";

const allowedStoreTargets = new Set([
  "accepted",
  "preparing",
  "ready_for_dispatch",
]);

export function createStoreOrdersRouter({
  StoreModel = Store,
  ParentOrderModel = ParentOrder,
  SubOrderModel = SubOrder,
  ProductModel = Product,
  DeliveryModel = Delivery,
  UserModel = User,
  connection = mongoose.connection,
  authenticate = requireAuth,
  authorizeStore = requireRoles("supermarket", "admin"),
  authorizeSupermarket = requireRoles("supermarket"),
  roleProvider = getUserRole,
} = {}) {
  const router = Router();

  router.get("/:storeId/dashboard/summary", authenticate, authorizeStore, asyncHandler(async (req, res) => {
    const access = await resolveStoreAccess({ req, storeKey: req.params.storeId, StoreModel, roleProvider });
    if (access.response) return res.status(access.response.status).json(access.response.body);

    const storeId = access.store._id;
    const [groups, recent] = await Promise.all([
      SubOrderModel.aggregate([
        { $match: { storeId } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      SubOrderModel.find({ storeId })
        .select("subOrderNumber parentOrderNumber storeSlug storeName items merchandiseSubtotalKobo totalKobo status createdAt parentOrderId")
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ]);
    const countsByStatus = Object.fromEntries(groups.map(({ _id, count }) => [_id, count]));
    const parentIds = [...new Set(recent.map((order) => String(order.parentOrderId)))];
    const parents = parentIds.length
      ? await ParentOrderModel.find({ _id: { $in: parentIds } }).select("_id paymentStatus").lean()
      : [];
    const paymentStatusByParent = new Map(parents.map((parent) => [String(parent._id), parent.paymentStatus]));

    return res.json({
      store: {
        id: access.store.slug,
        name: access.store.name,
        isActive: access.store.isActive,
        isApproved: access.store.isApproved,
      },
      summary: {
        totalOrders: Object.values(countsByStatus).reduce((sum, count) => sum + count, 0),
        pendingPaymentOrders: countsByStatus.pending_payment ?? 0,
        awaitingFulfilmentOrders: (countsByStatus.pending_fulfilment ?? 0) + (countsByStatus.accepted ?? 0),
        preparingOrders: countsByStatus.preparing ?? 0,
        readyForDispatchOrders: countsByStatus.ready_for_dispatch ?? 0,
        dispatchedOrders: countsByStatus.dispatched ?? 0,
        completedOrders: countsByStatus.delivered ?? 0,
        cancelledOrders: countsByStatus.cancelled ?? 0,
        unableToFulfilOrders: countsByStatus.unable_to_fulfil ?? 0,
        customerActionRequiredOrders: countsByStatus.customer_action_required ?? 0,
      },
      recentOrders: recent.map((order) => ({
        id: order.subOrderNumber,
        subOrderNumber: order.subOrderNumber,
        parentOrderNumber: order.parentOrderNumber,
        storeId: order.storeSlug,
        storeName: order.storeName,
        itemCount: order.items?.length ?? 0,
        merchandiseSubtotalKobo: order.merchandiseSubtotalKobo,
        totalKobo: order.totalKobo,
        status: order.status,
        paymentStatus: paymentStatusByParent.get(String(order.parentOrderId)) ?? "pending",
        createdAt: order.createdAt,
      })),
    });
  }));

  router.get("/:storeId/orders", authenticate, authorizeStore, asyncHandler(async (req, res) => {
    const access = await resolveStoreAccess({ req, storeKey: req.params.storeId, StoreModel, roleProvider });
    if (access.response) return res.status(access.response.status).json(access.response.body);
    const { page, limit } = pagination(req.query);
    const filter = { storeId: access.store._id };
    if (req.query.status !== undefined) {
      const status = String(req.query.status);
      if (!SUB_ORDER_STATUSES.has(status)) throw new OrderWorkflowError(400, "INVALID_ORDER_STATUS", "Unknown sub-order status");
      filter.status = status;
    }
    const [subOrders, total] = await Promise.all([
      SubOrderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      SubOrderModel.countDocuments(filter),
    ]);
    const deliveries = subOrders.length ? await DeliveryModel.find({ subOrderId: { $in: subOrders.map((entry) => entry._id) } }).lean() : [];
    const riders = deliveries.length ? await UserModel.find({ _id: { $in: deliveries.map((entry) => entry.assignedRiderUserId).filter(Boolean) } }).select("_id firstName lastName phone").lean() : [];
    const riderById = new Map(riders.map((rider) => [rider._id, rider]));
    const deliveryByOrder = new Map(deliveries.map((entry) => [String(entry.subOrderId), entry]));
    return res.json({ orders: subOrders.map((entry) => { const delivery = deliveryByOrder.get(String(entry._id)); return { ...publicStoreSummary(entry), deliveryProgress: safeStoreDelivery(delivery, riderById.get(delivery?.assignedRiderUserId)) }; }), page, limit, total });
  }));

  router.get("/:storeId/orders/:orderId", authenticate, authorizeStore, asyncHandler(async (req, res) => {
    const access = await resolveStoreAccess({ req, storeKey: req.params.storeId, StoreModel, roleProvider });
    if (access.response) return res.status(access.response.status).json(access.response.body);
    const subOrder = await findStoreSubOrder(SubOrderModel, access.store._id, req.params.orderId);
    if (!subOrder) return res.status(404).json({ error: { code: "SUB_ORDER_NOT_FOUND", message: "Order not found for this supermarket" } });
    const parent = await ParentOrderModel.findById(subOrder.parentOrderId).select("orderNumber delivery status paymentStatus createdAt updatedAt").lean();
    const deliveryRecord = await DeliveryModel.findOne({ subOrderId: subOrder._id }).lean();
    const assignedRider = deliveryRecord?.assignedRiderUserId ? await UserModel.findOne({ _id: deliveryRecord.assignedRiderUserId }).select("firstName lastName phone").lean() : null;
    return res.json({ order: {
      ...publicStoreSummary(subOrder),
      deliveryProgress: safeStoreDelivery(deliveryRecord, assignedRider),
      delivery: parent?.delivery,
      parentStatus: parent?.status,
      paymentStatus: parent?.paymentStatus ?? "pending",
      parentCreatedAt: parent?.createdAt,
      parentUpdatedAt: parent?.updatedAt,
    } });
  }));

  router.post("/:storeId/orders/:orderId/items/:productId/unavailable", authenticate, authorizeStore, asyncHandler(async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== "reason")) {
      return res.status(400).json({ error: { code: "INVALID_EXCEPTION_REQUEST", message: "Only a reason may be supplied" } });
    }
    const access = await resolveStoreAccess({ req, storeKey: req.params.storeId, StoreModel, roleProvider });
    if (access.response) return res.status(access.response.status).json(access.response.body);
    const item = await reportUnavailableItem({
      storeDbId: access.store._id,
      subOrderId: req.params.orderId,
      productId: req.params.productId,
      reason: req.body.reason,
      ParentOrderModel,
      SubOrderModel,
      ProductModel,
      connection,
    });
    return res.json({ item });
  }));

  router.post("/:storeId/orders/:orderId/unable-to-fulfil", authenticate, authorizeStore, asyncHandler(async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== "reason")) {
      return res.status(400).json({ error: { code: "INVALID_EXCEPTION_REQUEST", message: "Only a reason may be supplied" } });
    }
    const access = await resolveStoreAccess({ req, storeKey: req.params.storeId, StoreModel, roleProvider });
    if (access.response) return res.status(access.response.status).json(access.response.body);
    const action = await requestStoreCannotFulfil({
      storeDbId: access.store._id,
      subOrderId: req.params.orderId,
      reason: req.body.reason,
      ParentOrderModel,
      SubOrderModel,
      connection,
    });
    return res.json({ action });
  }));

  router.patch("/:storeId/orders/:orderId/fulfillment", authenticate, authorizeStore, asyncHandler(async (req, res) => {
    if (!req.body || Object.keys(req.body).some((key) => key !== "status")) {
      return res.status(400).json({ error: { code: "INVALID_FULFILLMENT_REQUEST", message: "Only status may be supplied" } });
    }
    const nextStatus = req.body.status;
    if (!allowedStoreTargets.has(nextStatus)) {
      return res.status(400).json({ error: { code: "INVALID_FULFILLMENT_STATUS", message: "This status cannot be set by a supermarket" } });
    }
    const access = await resolveStoreAccess({ req, storeKey: req.params.storeId, StoreModel, roleProvider });
    if (access.response) return res.status(access.response.status).json(access.response.body);
    const session = await connection.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const query = subOrderLookup(req.params.orderId);
        const subOrder = await SubOrderModel.findOne({ ...query, storeId: access.store._id }).session(session).lean();
        if (!subOrder) throw new OrderWorkflowError(404, "SUB_ORDER_NOT_FOUND", "Order not found for this supermarket");
        const parent = await ParentOrderModel.findById(subOrder.parentOrderId).session(session).lean();
        if (!parent) throw new OrderWorkflowError(404, "ORDER_NOT_FOUND", "Parent order not found");
        if (parent.paymentStatus !== "paid") {
          throw new OrderWorkflowError(409, "PAYMENT_NOT_CONFIRMED", "Supermarket fulfilment can begin after verified payment only.");
        }
        if (!isValidSubOrderTransition(subOrder.status, nextStatus)) {
          throw new OrderWorkflowError(409, "INVALID_STATUS_TRANSITION", `Cannot move a sub-order from ${subOrder.status} to ${nextStatus}.`);
        }
        if (nextStatus === "ready_for_dispatch" && (!access.store.isActive || !access.store.isApproved || access.store.approvalStatus === "rejected" || parent.customerAction?.decision === "pending")) {
          throw new OrderWorkflowError(409, "STORE_ORDER_NOT_DISPATCHABLE", "This order requires an active approved store and no pending customer decision before pickup readiness.");
        }
        const update = { status: nextStatus };
        if (["preparing", "ready_for_dispatch"].includes(nextStatus)) {
          update.items = subOrder.items.map((item) => ({
            ...(item.toObject ? item.toObject() : item),
            fulfilmentStatus: item.fulfilmentStatus === "unavailable"
              ? "unavailable"
              : nextStatus === "preparing" ? "preparing" : "fulfilled",
          }));
        }
        const updated = await SubOrderModel.findOneAndUpdate(
          { _id: subOrder._id, storeId: access.store._id, status: subOrder.status },
          { $set: update },
          { new: true, session, runValidators: true },
        ).lean();
        if (!updated) throw new OrderWorkflowError(409, "ORDER_CHANGED", "The order status changed. Refresh and try again.");

        if (nextStatus === "ready_for_dispatch") {
          const auth = req.auth;
          await DeliveryModel.updateOne({ subOrderId: subOrder._id }, { $setOnInsert: {
            parentOrderId: parent._id, parentOrderNumber: parent.orderNumber,
            subOrderId: subOrder._id, subOrderNumber: subOrder.subOrderNumber,
            storeId: access.store._id, storeSlug: access.store.slug, storeName: access.store.name,
            customerUserId: parent.customerUserId, destination: parent.delivery,
            status: "awaiting_assignment",
            history: [{ actorUserId: auth.userId, actorRole: "supermarket", action: "ready_for_pickup", fromStatus: "", toStatus: "awaiting_assignment", createdAt: new Date() }],
          } }, { upsert: true, session, runValidators: true });
        }

        const childOrders = await SubOrderModel.find({ parentOrderId: parent._id }).session(session).select("status").lean();
        const parentStatus = deriveParentOrderStatus(parent.paymentStatus, childOrders.map((child) => child.status));
        if (parent.status !== parentStatus && !isValidParentOrderTransition(parent.status, parentStatus)) {
          throw new OrderWorkflowError(409, "INVALID_PARENT_STATUS_TRANSITION", `Cannot move a parent order from ${parent.status} to ${parentStatus}.`);
        }
        if (parent.status !== parentStatus) {
          const parentUpdate = { status: parentStatus };
          const parentUpdated = await ParentOrderModel.updateOne({ _id: parent._id, paymentStatus: "paid" }, { $set: parentUpdate }, { session });
          if ((parentUpdated.modifiedCount ?? parentUpdated.nModified) !== 1) {
            throw new OrderWorkflowError(409, "ORDER_CHANGED", "The parent order changed. Refresh and try again.");
          }
        }
        const deliveryRecord = nextStatus === "ready_for_dispatch" ? await DeliveryModel.findOne({ subOrderId: subOrder._id }).session(session).lean() : null;
        result = { order: publicStoreSummary(updated), delivery: parent.delivery, deliveryProgress: safeStoreDelivery(deliveryRecord), parentStatus, paymentStatus: parent.paymentStatus };
      });
    } finally {
      await session.endSession();
    }
    return res.json(result);
  }));

  router.post("/:storeId/orders/:orderId/handover", authenticate, authorizeSupermarket, asyncHandler(async (req, res) => {
    if (Object.keys(req.body || {}).length) throw new OrderWorkflowError(400, "INVALID_HANDOVER_REQUEST", "Handover does not accept request fields.");
    const access = await resolveStoreAccess({ req, storeKey: req.params.storeId, StoreModel, roleProvider });
    if (access.response) return res.status(access.response.status).json(access.response.body);
    const session = await connection.startSession();
    let result;
    try {
      await session.withTransaction(async () => {
        const subOrder = await SubOrderModel.findOne({ ...subOrderLookup(req.params.orderId), storeId: access.store._id }).session(session).lean();
        if (!subOrder) throw new OrderWorkflowError(404, "SUB_ORDER_NOT_FOUND", "Order not found for this supermarket.");
        const parent = await ParentOrderModel.findById(subOrder.parentOrderId).session(session).lean();
        const delivery = await DeliveryModel.findOne({ subOrderId: subOrder._id }).session(session).lean();
        if (!parent || parent.paymentStatus !== "paid" || subOrder.status !== "ready_for_dispatch") throw new OrderWorkflowError(409, "HANDOVER_NOT_READY", "Only a paid order ready for pickup can be handed over.");
        if (!delivery || delivery.status !== "arrived_at_pickup" || !delivery.assignedRiderUserId) throw new OrderWorkflowError(409, "RIDER_NOT_READY", "The assigned rider must arrive before handover.");
        const now = new Date();
        const auth = req.auth;
        const updatedDelivery = await DeliveryModel.findOneAndUpdate(
          { _id: delivery._id, status: "arrived_at_pickup", assignedRiderUserId: delivery.assignedRiderUserId },
          { $set: { status: "picked_up", pickedUpAt: now }, $push: { history: { actorUserId: auth.userId, actorRole: "supermarket", action: "store_confirmed_handover", fromStatus: "arrived_at_pickup", toStatus: "picked_up", createdAt: now } } },
          { new: true, session, runValidators: true },
        ).lean();
        const updatedOrder = await SubOrderModel.findOneAndUpdate(
          { _id: subOrder._id, status: "ready_for_dispatch" },
          { $set: { status: "dispatched", reservationStatus: "consumed", items: subOrder.items.map((item) => ({ ...(item.toObject ? item.toObject() : item), fulfilmentStatus: item.fulfilmentStatus === "unavailable" ? "unavailable" : "fulfilled", ...(item.fulfilmentStatus !== "unavailable" ? { reservationStatus: "consumed" } : {}) })) } },
          { new: true, session, runValidators: true },
        ).lean();
        if (!updatedDelivery || !updatedOrder) throw new OrderWorkflowError(409, "HANDOVER_CHANGED", "The delivery changed. Refresh and try again.");
        result = { order: publicStoreSummary(updatedOrder), deliveryProgress: safeStoreDelivery(updatedDelivery) };
      });
    } finally { await session.endSession(); }
    return res.json(result);
  }));

  return router;
}

const SUB_ORDER_STATUSES = new Set(["pending_payment", "pending_fulfilment", "accepted", "preparing", "ready_for_dispatch", "dispatched", "delivered", "unable_to_fulfil", "customer_action_required", "cancelled"]);

async function resolveStoreAccess({ req, storeKey, StoreModel, roleProvider }) {
  const stores = await StoreModel.find({ $or: storeLookup(storeKey) })
    .select("_id slug name ownerUserId isActive isApproved")
    .lean();
  const isMongoId = /^[a-f\d]{24}$/i.test(storeKey);
  const store = (isMongoId ? stores.find((candidate) => String(candidate._id).toLowerCase() === storeKey.toLowerCase()) : null)
    ?? stores.find((candidate) => candidate.slug === storeKey.toLowerCase());
  if (!store) return { response: { status: 404, body: { error: { code: "STORE_NOT_FOUND", message: "Store not found" } } } };
  const auth = req.auth;
  const role = await roleProvider(auth);
  if (role !== "admin" && store.ownerUserId !== auth.userId) {
    return { response: { status: 404, body: { error: { code: "STORE_NOT_FOUND", message: "Store not found" } } } };
  }
  return { store };
}

function subOrderLookup(id) {
  return /^[a-f\d]{24}$/i.test(id) ? { _id: id } : { subOrderNumber: id };
}

async function findStoreSubOrder(SubOrderModel, storeId, id) {
  return SubOrderModel.findOne({ ...subOrderLookup(id), storeId }).lean();
}

function pagination(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 20 : Number(query.limit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100");
  }
  return { page, limit };
}

function publicStoreSummary(subOrder) {
  return {
    id: subOrder.subOrderNumber,
    subOrderNumber: subOrder.subOrderNumber,
    parentOrderNumber: subOrder.parentOrderNumber,
    storeId: subOrder.storeSlug,
    storeName: subOrder.storeName,
    items: subOrder.items?.map((item) => ({
      productId: item.productKey,
      productName: item.productName,
      unitPriceKobo: item.unitPriceKobo,
      quantity: item.quantity,
      lineTotalKobo: item.lineTotalKobo,
      fulfilmentStatus: item.fulfilmentStatus,
      refundAmountKobo: item.refundAmountKobo,
      refundStatus: item.refundStatus ?? "not_applicable",
      unavailableReason: item.unavailableReason ?? "",
      unavailableAt: item.unavailableAt ?? null,
      reservationStatus: item.reservationStatus ?? "held",
      auditEvents: item.auditEvents ?? [],
    })),
    merchandiseSubtotalKobo: subOrder.merchandiseSubtotalKobo,
    deliveryFeeKobo: subOrder.deliveryFeeKobo,
    serviceFeeKobo: subOrder.serviceFeeKobo,
    totalKobo: subOrder.totalKobo,
    remainingMerchandiseKobo: subOrder.fulfilmentSubtotalKobo ?? subOrder.items
      .filter((item) => item.fulfilmentStatus !== "unavailable")
      .reduce((sum, item) => sum + item.lineTotalKobo, 0),
    reservationStatus: subOrder.reservationStatus ?? "held",
    status: subOrder.status,
    cancellation: subOrder.cancellation,
    customerAction: subOrder.customerAction,
    createdAt: subOrder.createdAt,
    updatedAt: subOrder.updatedAt,
  };
}

function safeStoreDelivery(delivery, rider) {
  if (!delivery) return null;
  return { id: String(delivery._id), status: delivery.status, assigned: Boolean(delivery.assignedRiderUserId), rider: rider ? { firstName: rider.firstName || "", lastName: rider.lastName || "", phone: rider.phone || "" } : null, assignedAt: delivery.assignedAt, acceptedAt: delivery.acceptedAt, arrivedAt: delivery.arrivedAt, pickedUpAt: delivery.pickedUpAt, dispatchedAt: delivery.dispatchedAt, deliveredAt: delivery.deliveredAt, failedAt: delivery.failedAt, failureReason: delivery.failureReason || "" };
}

