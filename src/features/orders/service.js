import { createHash, randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { getCheckoutPricing } from "../../config/checkoutPricing.js";
import { buildCheckoutQuote, validateCheckoutRequest } from "../checkout/pricing.js";
import { resolveCartItems } from "../checkout/resolveCart.js";
import { ParentOrder } from "../../models/ParentOrder.js";
import { SubOrder } from "../../models/SubOrder.js";
import { Product } from "../../models/Product.js";
import { Store } from "../../models/Store.js";

export const subOrderTransitions = {
  pending_payment: ["pending_fulfilment", "cancelled"],
  pending_fulfilment: ["accepted", "customer_action_required", "unable_to_fulfil", "cancelled"],
  accepted: ["preparing", "customer_action_required", "unable_to_fulfil", "cancelled"],
  preparing: ["ready_for_dispatch", "customer_action_required", "unable_to_fulfil", "cancelled"],
  ready_for_dispatch: ["dispatched", "unable_to_fulfil"],
  dispatched: ["delivered"],
  delivered: [],
  unable_to_fulfil: [],
  customer_action_required: [],
  cancelled: [],
};

export const parentOrderTransitions = {
  pending_payment: ["confirmed", "cancelled", "customer_action_required"],
  confirmed: ["processing", "cancelled", "customer_action_required"],
  processing: ["partially_fulfilled", "completed", "cancelled", "customer_action_required"],
  partially_fulfilled: ["completed", "cancelled", "customer_action_required"],
  customer_action_required: ["processing", "partially_fulfilled", "cancelled"],
  completed: [],
  cancelled: [],
};

export function isValidSubOrderTransition(current, next) {
  return subOrderTransitions[current]?.includes(next) ?? false;
}

export function isValidParentOrderTransition(current, next) {
  return parentOrderTransitions[current]?.includes(next) ?? false;
}

export function deriveParentOrderStatus(paymentStatus, childStatuses) {
  if (paymentStatus !== "paid") return "pending_payment";
  if (!childStatuses.length) return "confirmed";
  if (childStatuses.includes("customer_action_required")) return "customer_action_required";
  if (childStatuses.every((status) => status === "delivered")) return "completed";
  if (childStatuses.every((status) => status === "cancelled")) return "cancelled";
  if (childStatuses.some((status) => ["delivered", "cancelled", "unable_to_fulfil"].includes(status))) return "partially_fulfilled";
  return "processing";
}

export class OrderWorkflowError extends Error {
  constructor(status, apiCode, message, details = {}) {
    super(message);
    this.status = status;
    this.apiCode = apiCode;
    this.details = details;
  }
}

export function validateCreateOrderRequest(body, idempotencyKey) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "The request body must be an object" };
  }
  if (Object.keys(body).some((key) => !["items", "delivery"].includes(key))) {
    return { error: "Only items and delivery details are accepted; prices and totals are calculated by the server" };
  }
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
    return { error: "A valid Idempotency-Key header of 8 to 128 characters is required" };
  }

  const itemsValidation = validateCheckoutRequest({ items: body.items });
  if (itemsValidation.error) return itemsValidation;
  const delivery = body.delivery;
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) {
    return { error: "delivery must contain fullName, address, and phone" };
  }
  if (Object.keys(delivery).some((key) => !["fullName", "address", "phone"].includes(key))) {
    return { error: "delivery may contain only fullName, address, and phone" };
  }
  const normalizedDelivery = {};
  for (const [field, maxLength] of [["fullName", 120], ["address", 500], ["phone", 32]]) {
    const value = delivery[field];
    if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
      return { error: `delivery.${field} must be a non-empty string of at most ${maxLength} characters` };
    }
    normalizedDelivery[field] = value.trim();
  }
  return { items: itemsValidation.items, delivery: normalizedDelivery, idempotencyKey };
}

export function fingerprintOrderRequest(items, delivery) {
  const canonical = {
    items: [...items].map(({ storeId, productId, quantity }) => ({ storeId, productId, quantity }))
      .sort((a, b) => {
        const left = `${a.storeId}\u0000${a.productId}`;
        const right = `${b.storeId}\u0000${b.productId}`;
        return left < right ? -1 : left > right ? 1 : 0;
      }),
    delivery: { fullName: delivery.fullName, address: delivery.address, phone: delivery.phone },
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function allocateFeeAcrossStores(totalFeeKobo, stores) {
  const ordered = [...stores].sort((a, b) => a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0);
  if (!ordered.length) return new Map();
  const base = Math.floor(totalFeeKobo / ordered.length);
  let remainder = totalFeeKobo - base * ordered.length;
  return new Map(ordered.map((store) => {
    const allocation = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return [store.storeId, allocation];
  }));
}

function publicSubOrder(subOrder) {
  const remainingMerchandiseKobo = subOrder.items.filter((item) => item.fulfilmentStatus !== "unavailable")
    .reduce((sum, item) => sum + item.lineTotalKobo, 0);
  return {
    id: subOrder.subOrderNumber,
    subOrderNumber: subOrder.subOrderNumber,
    parentOrderNumber: subOrder.parentOrderNumber,
    storeId: subOrder.storeSlug,
    storeName: subOrder.storeName,
    items: subOrder.items.map((item) => ({
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
    remainingMerchandiseKobo: subOrder.fulfilmentSubtotalKobo ?? remainingMerchandiseKobo,
    reservationStatus: subOrder.reservationStatus ?? "held",
    reservationReleasedAt: subOrder.reservationReleasedAt ?? null,
    status: subOrder.status,
    cancellation: subOrder.cancellation,
    customerAction: subOrder.customerAction,
    createdAt: subOrder.createdAt,
    updatedAt: subOrder.updatedAt,
  };
}

export function publicParentOrder(order, subOrders = []) {
  return {
    id: order.orderNumber,
    orderNumber: order.orderNumber,
    delivery: order.delivery,
    merchandiseSubtotalKobo: order.merchandiseSubtotalKobo,
    deliveryFeeKobo: order.deliveryFeeKobo,
    serviceFeeKobo: order.serviceFeeKobo,
    totalKobo: order.totalKobo,
    minimumStoreSubtotalKobo: order.minimumStoreSubtotalKobo,
    paymentStatus: order.paymentStatus,
    status: order.status,
    cancelledAt: order.cancelledAt,
    cancellationReason: order.cancellationReason,
    customerAction: order.customerAction,
    customerActionHistory: order.customerActionHistory ?? [],
    refundObligations: order.refundObligations ?? [],
    subOrders: subOrders.map(publicSubOrder),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

function allocateStores(quote) {
  const delivery = allocateFeeAcrossStores(quote.deliveryFeeKobo, quote.stores);
  const service = allocateFeeAcrossStores(quote.serviceFeeKobo, quote.stores);
  return quote.stores.map((store) => ({
    ...store,
    deliveryFeeKobo: delivery.get(store.storeId) ?? 0,
    serviceFeeKobo: service.get(store.storeId) ?? 0,
  }));
}

function checkDuplicateProducts(items) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.productObjectId)) {
      throw new OrderWorkflowError(400, "DUPLICATE_PRODUCT", "Each product may appear only once per supermarket in an order.");
    }
    seen.add(item.productObjectId);
  }
}

async function findExistingOrder(ParentOrderModel, customerId, key) {
  return ParentOrderModel.findOne({ customerClerkUserId: customerId, idempotencyKey: key }).lean();
}

export async function loadParentOrder({ ParentOrderModel, SubOrderModel, orderId, customerClerkUserId }) {
  const query = /^[a-f\d]{24}$/i.test(orderId) ? { _id: orderId } : { orderNumber: orderId };
  const order = await ParentOrderModel.findOne({ ...query, customerClerkUserId }).lean();
  if (!order) return null;
  const subOrders = await SubOrderModel.find({ parentOrderId: order._id }).sort({ createdAt: 1 }).lean();
  return publicParentOrder(order, subOrders);
}

export async function createParentOrder({
  customerClerkUserId,
  input,
  pricing = getCheckoutPricing(),
  ParentOrderModel = ParentOrder,
  SubOrderModel = SubOrder,
  ProductModel = Product,
  StoreModel = Store,
  connection = mongoose.connection,
  now = new Date(),
  reservationTtlMinutes = 15,
}) {
  const fingerprint = fingerprintOrderRequest(input.items, input.delivery);
  const existing = await findExistingOrder(ParentOrderModel, customerClerkUserId, input.idempotencyKey);
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) {
      throw new OrderWorkflowError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different order request.");
    }
    const result = await loadParentOrder({ ParentOrderModel, SubOrderModel, orderId: String(existing._id), customerClerkUserId });
    return { order: result, reused: true };
  }

  const session = await connection.startSession();
  let orderId;
  let reused = false;
  try {
    await session.withTransaction(async () => {
      const inTransaction = await ParentOrderModel.findOne({ customerClerkUserId, idempotencyKey: input.idempotencyKey }).session(session).lean();
      if (inTransaction) {
        if (inTransaction.requestFingerprint !== fingerprint) {
          throw new OrderWorkflowError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different order request.");
        }
        orderId = inTransaction._id;
        reused = true;
        return;
      }

      const resolved = await resolveCartItems({
        items: input.items,
        StoreModel,
        ProductModel,
        session,
      });
      if (resolved.issues.length) {
        throw new OrderWorkflowError(409, "CART_VALIDATION_FAILED", "One or more cart items cannot be fulfilled at the current price or stock level.", { issues: resolved.issues });
      }
      checkDuplicateProducts(resolved.items);
      const quote = buildCheckoutQuote(resolved.items, pricing);
      if (!quote.eligible) {
        throw new OrderWorkflowError(409, "MINIMUM_ORDER_NOT_MET", "Each supermarket must independently meet its minimum merchandise subtotal.", { quote });
      }

      for (const item of resolved.items) {
        const result = await ProductModel.updateOne({
          _id: item.productObjectId,
          storeId: item.storeObjectId,
          isAvailable: true,
          stockQuantity: { $gte: item.quantity },
        }, { $inc: { stockQuantity: -item.quantity } }, { session });
        if ((result.modifiedCount ?? result.nModified) !== 1) {
          throw new OrderWorkflowError(409, "STOCK_CHANGED", "Stock changed while creating your order. Refresh your cart and request a new quote.", {
            issues: [{ storeId: item.storeId, productId: item.productId, code: "INSUFFICIENT_STOCK", message: "Stock changed before reservation." }],
          });
        }
      }

      const storeQuotes = allocateStores(quote);
      const orderNumber = `GS-${randomUUID().slice(0, 8).toUpperCase()}`;
      const parent = (await ParentOrderModel.create([{
        orderNumber,
        customerClerkUserId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        subOrderIds: [],
        delivery: input.delivery,
        merchandiseSubtotalKobo: quote.merchandiseSubtotalKobo,
        deliveryFeeKobo: quote.deliveryFeeKobo,
        serviceFeeKobo: quote.serviceFeeKobo,
        totalKobo: quote.totalKobo,
        minimumStoreSubtotalKobo: pricing.minimumStoreSubtotalKobo,
        status: "pending_payment",
        paymentStatus: "pending",
        reservationStatus: "held",
        reservationExpiresAt: new Date(now.getTime() + reservationTtlMinutes * 60_000),
      }], { session }))[0];

      const subOrderDocs = storeQuotes.map((store, index) => {
        const storeItems = resolved.items.filter((item) => item.storeId === store.storeId);
        const itemsSubtotalKobo = storeItems.reduce((sum, item) => sum + item.unitPriceKobo * item.quantity, 0);
        const totalKobo = itemsSubtotalKobo + store.deliveryFeeKobo + store.serviceFeeKobo;
        return {
          subOrderNumber: `${orderNumber}-${String(index + 1).padStart(2, "0")}`,
          parentOrderId: parent._id,
          parentOrderNumber: orderNumber,
          customerClerkUserId,
          storeId: storeItems[0].storeObjectId,
          storeSlug: store.storeId,
          storeName: store.storeName,
          items: storeItems.map((item) => ({
            productId: item.productObjectId,
            productKey: item.productId,
            productName: item.productName,
            unitPriceKobo: item.unitPriceKobo,
            quantity: item.quantity,
            lineTotalKobo: item.unitPriceKobo * item.quantity,
            fulfilmentStatus: "pending",
            refundAmountKobo: 0,
            refundStatus: "not_applicable",
            reservationStatus: "held",
            auditEvents: [],
          })),
          merchandiseSubtotalKobo: itemsSubtotalKobo,
          deliveryFeeKobo: store.deliveryFeeKobo,
          serviceFeeKobo: store.serviceFeeKobo,
          totalKobo,
          status: "pending_payment",
          reservationStatus: "held",
        };
      });
      const subOrders = await SubOrderModel.create(subOrderDocs, { session });
      parent.subOrderIds = subOrders.map((subOrder) => subOrder._id);
      await parent.save({ session });
      orderId = parent._id;
    });
  } catch (error) {
    if (error.code === 11000) {
      const concurrentExisting = await findExistingOrder(ParentOrderModel, customerClerkUserId, input.idempotencyKey);
      if (concurrentExisting) {
        if (concurrentExisting.requestFingerprint !== fingerprint) {
          throw new OrderWorkflowError(409, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was already used for a different order request.");
        }
        orderId = concurrentExisting._id;
        reused = true;
      } else {
        throw error;
      }
    } else if (/Transaction numbers are only allowed|replica set|mongos/i.test(error.message)) {
      throw new OrderWorkflowError(503, "TRANSACTIONS_REQUIRED", "Order creation requires MongoDB running as a replica set or sharded cluster.");
    } else {
      throw error;
    }
  } finally {
    await session.endSession();
  }

  const order = await loadParentOrder({ ParentOrderModel, SubOrderModel, orderId: String(orderId), customerClerkUserId });
  return { order, reused };
}

function withSession(query, session) {
  return session ? query.session(session) : query;
}

export async function releaseOrderReservation({ parent, subOrders, session, ProductModel = Product }) {
  if (parent.reservationStatus !== "held") return false;
  for (const subOrder of subOrders) {
    for (const item of subOrder.items) {
      const result = await ProductModel.updateOne({ _id: item.productId, storeId: subOrder.storeId }, {
        $inc: { stockQuantity: item.quantity },
      }, { session });
      if ((result.modifiedCount ?? result.nModified) !== 1) {
        throw new Error("Unable to restore reserved inventory while releasing the order");
      }
    }
  }
  const now = new Date();
  parent.reservationStatus = "released";
  parent.reservationReleasedAt = now;
  parent.cancelledAt = now;
  parent.cancellationReason = parent.cancellationReason || "Customer cancelled before payment";
  parent.status = "cancelled";
  await parent.save({ session });
  return true;
}

export async function cancelPendingOrder({
  orderId,
  customerClerkUserId,
  ParentOrderModel = ParentOrder,
  SubOrderModel = SubOrder,
  ProductModel = Product,
  connection = mongoose.connection,
}) {
  const idQuery = /^[a-f\d]{24}$/i.test(orderId) ? { _id: orderId } : { orderNumber: orderId };
  const session = await connection.startSession();
  let found = false;
  try {
    await session.withTransaction(async () => {
      const parent = await withSession(ParentOrderModel.findOne({ ...idQuery, customerClerkUserId }), session).lean();
      if (!parent) return;
      found = true;
      if (parent.status === "cancelled") return;
      if (parent.status !== "pending_payment" || parent.paymentStatus !== "pending") {
        throw new OrderWorkflowError(409, "ORDER_CANNOT_BE_CANCELLED", "Only an unpaid order can be cancelled at this stage.");
      }
      const subOrders = await withSession(SubOrderModel.find({ parentOrderId: parent._id }), session).lean();
      const parentDoc = await withSession(ParentOrderModel.findOne({ _id: parent._id }), session);
      await releaseOrderReservation({ parent: parentDoc, subOrders, session, ProductModel });
      await SubOrderModel.updateMany({ parentOrderId: parent._id, status: "pending_payment" }, {
        $set: {
          status: "cancelled",
          "cancellation.reason": "Customer cancelled before payment",
          "cancellation.cancelledAt": new Date(),
          "cancellation.cancelledBy": "customer",
        },
      }, { session });
    });
  } finally {
    await session.endSession();
  }
  if (!found) return null;
  return loadParentOrder({ ParentOrderModel, SubOrderModel, orderId, customerClerkUserId });
}

export async function expirePendingOrderReservations({
  ParentOrderModel = ParentOrder,
  SubOrderModel = SubOrder,
  ProductModel = Product,
  connection = mongoose.connection,
  now = new Date(),
  limit = 100,
}) {
  const candidates = await ParentOrderModel.find({
    status: "pending_payment",
    paymentStatus: "pending",
    reservationStatus: "held",
    reservationExpiresAt: { $lte: now },
  }).select("_id").sort({ reservationExpiresAt: 1 }).limit(limit).lean();
  let releasedCount = 0;

  for (const candidate of candidates) {
    const session = await connection.startSession();
    let releasedInTransaction = false;
    try {
      await session.withTransaction(async () => {
        const parent = await withSession(ParentOrderModel.findOne({
          _id: candidate._id,
          status: "pending_payment",
          paymentStatus: "pending",
          reservationStatus: "held",
          reservationExpiresAt: { $lte: now },
        }), session).lean();
        if (!parent) return;
        const subOrders = await withSession(SubOrderModel.find({ parentOrderId: parent._id }), session).lean();
        const parentDoc = await withSession(ParentOrderModel.findOne({ _id: parent._id }), session);
        const released = await releaseOrderReservation({ parent: parentDoc, subOrders, session, ProductModel });
        if (released) {
          parentDoc.cancellationReason = "Payment reservation expired";
          await parentDoc.save({ session });
          await SubOrderModel.updateMany({ parentOrderId: parent._id, status: "pending_payment" }, {
            $set: {
              status: "cancelled",
              "cancellation.reason": "Payment reservation expired",
              "cancellation.cancelledAt": now,
              "cancellation.cancelledBy": "system",
            },
          }, { session });
          releasedInTransaction = true;
        }
      });
      if (releasedInTransaction) releasedCount += 1;
    } finally {
      await session.endSession();
    }
  }
  return releasedCount;
}
