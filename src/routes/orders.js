import { Router } from "express";
import { createHash, randomInt } from "node:crypto";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { ParentOrder } from "../models/ParentOrder.js";
import { Product } from "../models/Product.js";
import { SubOrder } from "../models/SubOrder.js";
import { Delivery } from "../models/Delivery.js";
import { User } from "../models/User.js";
import {
  cancelPendingOrder,
  createParentOrder,
  loadParentOrder,
  OrderWorkflowError,
  validateCreateOrderRequest,
} from "../features/orders/service.js";
import { decideCustomerAction, getCustomerActionRequest } from "../features/orders/exceptions.js";

export function createOrdersRouter({
  ParentOrderModel = ParentOrder,
  SubOrderModel = SubOrder,
  DeliveryModel = Delivery,
  UserModel = User,
  ProductModel = Product,
  connection,
  pricingProvider,
  reservationTtlMinutes,
  authenticate = requireAuth,
  authorizeCustomer = requireRoles("customer"),
} = {}) {
  const router = Router();
  router.use(authenticate, authorizeCustomer);
  router.param("deliveryId", (req, res, next, id) => /^[a-f\d]{24}$/i.test(id) ? next() : res.status(404).json({ error: { code: "DELIVERY_NOT_FOUND", message: "Delivery not found." } }));

  router.post("/", asyncHandler(async (req, res) => {
    const input = validateCreateOrderRequest(req.body, req.get("Idempotency-Key"));
    if (input.error) return res.status(400).json({ error: { code: "INVALID_ORDER_REQUEST", message: input.error } });
    const auth = req.auth;
    const result = await createParentOrder({
      customerUserId: auth.userId,
      input,
      ParentOrderModel,
      SubOrderModel,
      ProductModel,
      ...(connection ? { connection } : {}),
      ...(pricingProvider ? { pricing: await pricingProvider() } : {}),
      ...(reservationTtlMinutes ? { reservationTtlMinutes } : {}),
    });
    return res.status(result.reused ? 200 : 201).json({ order: result.order, reused: result.reused });
  }));

  router.get("/", asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req.query);
    const auth = req.auth;
    const [orders, total] = await Promise.all([
      ParentOrderModel.find({ customerUserId: auth.userId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ParentOrderModel.countDocuments({ customerUserId: auth.userId }),
    ]);
    const childOrders = orders.length
      ? await SubOrderModel.find({ parentOrderId: { $in: orders.map((order) => order._id) } }).sort({ createdAt: 1 }).lean()
      : [];
    const deliveries = childOrders.length ? await DeliveryModel.find({ subOrderId: { $in: childOrders.map((child) => child._id) } }).lean() : [];
    const riders = deliveries.length ? await UserModel.find({ _id: { $in: deliveries.map((d) => d.assignedRiderUserId).filter(Boolean) } }).select("_id firstName lastName phone").lean() : [];
    const deliveryBySubOrder = new Map(deliveries.map((d) => [String(d.subOrderId), d]));
    const riderById = new Map(riders.map((rider) => [rider._id, rider]));
    const result = orders.map((order) => ({
      ...publicOrderSummary(order),
      subOrders: childOrders.filter((child) => String(child.parentOrderId) === String(order._id)).map((child) => ({ ...publicOrderSummary(child), delivery: publicCustomerDelivery(deliveryBySubOrder.get(String(child._id)), riderById) })),
    }));
    return res.json({ orders: result, page, limit, total });
  }));

  router.get("/:orderId", asyncHandler(async (req, res) => {
    if (!validOrderId(req.params.orderId)) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    const auth = req.auth;
    const query = /^[a-f\d]{24}$/i.test(req.params.orderId) ? { _id: req.params.orderId } : { orderNumber: req.params.orderId };
    const parent = await ParentOrderModel.findOne({ ...query, customerUserId: auth.userId }).lean();
    if (!parent) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    const children = await SubOrderModel.find({ parentOrderId: parent._id }).sort({ createdAt: 1 }).lean();
    const deliveries = children.length ? await DeliveryModel.find({ subOrderId: { $in: children.map((child) => child._id) } }).lean() : [];
    const riders = deliveries.length ? await UserModel.find({ _id: { $in: deliveries.map((d) => d.assignedRiderUserId).filter(Boolean) } }).select("_id firstName lastName phone").lean() : [];
    const deliveryBySubOrder = new Map(deliveries.map((d) => [String(d.subOrderId), d]));
    const riderById = new Map(riders.map((rider) => [rider._id, rider]));
    const order = { ...publicOrderSummary(parent), subOrders: children.map((child) => ({ ...publicOrderSummary(child), delivery: publicCustomerDelivery(deliveryBySubOrder.get(String(child._id)), riderById) })) };
    return res.json({ order });
  }));

  router.post("/:orderId/deliveries/:deliveryId/code", asyncHandler(async (req, res) => {
    if (!validOrderId(req.params.orderId) || Object.keys(req.body || {}).length) throw new OrderWorkflowError(400, "INVALID_DELIVERY_CODE_REQUEST", "No request fields are accepted.");
    const auth = req.auth;
    const orderQuery = /^[a-f\d]{24}$/i.test(req.params.orderId) ? { _id: req.params.orderId } : { orderNumber: req.params.orderId };
    const parent = await ParentOrderModel.findOne({ ...orderQuery, customerUserId: auth.userId }).select("_id paymentStatus").lean();
    if (!parent) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found." } });
    const delivery = await DeliveryModel.findOne({ _id: req.params.deliveryId, parentOrderId: parent._id, customerUserId: auth.userId }).lean();
    if (!delivery) return res.status(404).json({ error: { code: "DELIVERY_NOT_FOUND", message: "Delivery not found." } });
    if (parent.paymentStatus !== "paid" || delivery.status !== "in_transit") throw new OrderWorkflowError(409, "DELIVERY_CODE_NOT_AVAILABLE", "A delivery code is available only while your order is out for delivery.");
    const now = new Date();
    const recentCount = delivery.proofOfDelivery?.codeIssuedAt && now.getTime() - new Date(delivery.proofOfDelivery.codeIssuedAt).getTime() < CODE_ISSUE_WINDOW_MS ? delivery.proofOfDelivery.codeIssueCount || 0 : 0;
    if (recentCount >= MAX_CODE_ISSUES) throw new OrderWorkflowError(429, "DELIVERY_CODE_RATE_LIMIT", "Too many code requests. Try again later.");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const updated = await DeliveryModel.findOneAndUpdate({ _id: delivery._id, customerUserId: auth.userId, status: "in_transit" }, { $set: { "proofOfDelivery.codeHash": createHash("sha256").update(code).digest("hex"), "proofOfDelivery.codeExpiresAt": new Date(now.getTime() + CODE_LIFETIME_MS), "proofOfDelivery.codeAttempts": 0, "proofOfDelivery.codeIssuedAt": now, "proofOfDelivery.codeIssueCount": recentCount + 1 } }, { new: true });
    if (!updated) throw new OrderWorkflowError(409, "DELIVERY_CHANGED", "Delivery status changed. Refresh and try again.");
    return res.json({ code, expiresAt: updated.proofOfDelivery.codeExpiresAt });
  }));

  router.get("/:orderId/customer-action", asyncHandler(async (req, res) => {
    if (!validOrderId(req.params.orderId)) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    const auth = req.auth;
    const action = await getCustomerActionRequest({
      orderId: req.params.orderId,
      customerUserId: auth.userId,
      ParentOrderModel,
      SubOrderModel,
    });
    if (!action) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    return res.json({ action });
  }));

  router.post("/:orderId/customer-action/decision", asyncHandler(async (req, res) => {
    if (!validOrderId(req.params.orderId)) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    if (!req.body || Object.keys(req.body).some((key) => key !== "decision")) {
      return res.status(400).json({ error: { code: "INVALID_CUSTOMER_DECISION", message: "Only decision may be supplied" } });
    }
    const auth = req.auth;
    const order = await decideCustomerAction({
      orderId: req.params.orderId,
      customerUserId: auth.userId,
      decision: req.body.decision,
      ParentOrderModel,
      SubOrderModel,
      ProductModel,
      ...(connection ? { connection } : {}),
    });
    if (!order) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    return res.json({ order });
  }));

  router.post("/:orderId/cancel", asyncHandler(async (req, res) => {
    if (!validOrderId(req.params.orderId)) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    const auth = req.auth;
    const order = await cancelPendingOrder({
      orderId: req.params.orderId,
      customerUserId: auth.userId,
      ParentOrderModel,
      SubOrderModel,
      ProductModel,
      ...(connection ? { connection } : {}),
    });
    if (!order) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    return res.json({ order });
  }));

  return router;
}

function validOrderId(value) {
  return typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9-]+$/.test(value);
}

function parsePagination(query) {
  const rawPage = query.page === undefined ? "1" : String(query.page);
  const rawLimit = query.limit === undefined ? "20" : String(query.limit);
  const page = /^\d+$/.test(rawPage) ? Number(rawPage) : NaN;
  const limit = /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100");
  }
  return { page, limit };
}

function publicOrderSummary(order) {
  if (order.storeSlug) {
    return {
      id: order.subOrderNumber,
      subOrderNumber: order.subOrderNumber,
      parentOrderNumber: order.parentOrderNumber,
      storeId: order.storeSlug,
      storeName: order.storeName,
      items: order.items.map((item) => ({
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
        auditEvents: item.auditEvents ?? [],
      })),
      merchandiseSubtotalKobo: order.merchandiseSubtotalKobo,
      deliveryFeeKobo: order.deliveryFeeKobo,
      serviceFeeKobo: order.serviceFeeKobo,
      totalKobo: order.totalKobo,
      remainingMerchandiseKobo: order.fulfilmentSubtotalKobo ?? order.items.filter((item) => item.fulfilmentStatus !== "unavailable").reduce((sum, item) => sum + item.lineTotalKobo, 0),
      status: order.status,
      cancellation: order.cancellation,
      customerAction: order.customerAction,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }
  return {
    id: order.orderNumber,
    orderNumber: order.orderNumber,
    delivery: order.delivery,
    merchandiseSubtotalKobo: order.merchandiseSubtotalKobo,
    deliveryFeeKobo: order.deliveryFeeKobo,
    serviceFeeKobo: order.serviceFeeKobo,
    totalKobo: order.totalKobo,
    paymentStatus: order.paymentStatus,
    status: order.status,
    refundObligations: order.refundObligations ?? [],
    customerAction: order.customerAction,
    customerActionHistory: order.customerActionHistory ?? [],
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function publicCustomerDelivery(delivery, riderById) {
  if (!delivery) return null;
  const rider = delivery.assignedRiderUserId ? riderById.get(delivery.assignedRiderUserId) : null;
  return {
    id: String(delivery._id), status: delivery.status, storeName: delivery.storeName,
    assignedAt: delivery.assignedAt, acceptedAt: delivery.acceptedAt, arrivedAt: delivery.arrivedAt,
    pickedUpAt: delivery.pickedUpAt, dispatchedAt: delivery.dispatchedAt, deliveredAt: delivery.deliveredAt,
    failedAt: delivery.failedAt, failureReason: delivery.failureReason || "",
    rider: rider ? { firstName: rider.firstName || "", lastName: rider.lastName || "", phone: rider.phone || "" } : null,
    history: (delivery.history || []).map((event) => ({ action: event.action, fromStatus: event.fromStatus, toStatus: event.toStatus, reason: event.reason, createdAt: event.createdAt })),
  };
}

const CODE_LIFETIME_MS = 15 * 60 * 1000;
const CODE_ISSUE_WINDOW_MS = 15 * 60 * 1000;
const MAX_CODE_ISSUES = 3;

