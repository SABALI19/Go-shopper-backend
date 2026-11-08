import mongoose from "mongoose";
import { ParentOrder } from "../../models/ParentOrder.js";
import { Product } from "../../models/Product.js";
import { SubOrder } from "../../models/SubOrder.js";
import { deriveParentOrderStatus, OrderWorkflowError, publicParentOrder } from "./service.js";

function orderLookup(id) {
  return /^[a-f\d]{24}$/i.test(id) ? { _id: id } : { subOrderNumber: id };
}

function validReason(reason) {
  return typeof reason === "string" && reason.trim().length > 0 && reason.trim().length <= 500;
}

function ensurePaid(parent) {
  if (parent.paymentStatus !== "paid") {
    throw new OrderWorkflowError(409, "PAYMENT_NOT_CONFIRMED", "Order exceptions can be processed after payment is verified only.");
  }
}

function sumPendingObligations(obligations = [], subOrderId) {
  return obligations.filter((entry) => String(entry.subOrderId) === String(subOrderId))
    .reduce((sum, entry) => sum + entry.amountKobo, 0);
}

function addObligation(obligations, entry) {
  if (!obligations.some((obligation) => obligation.key === entry.key)) obligations.push(entry);
}

function transactionError(error) {
  if (/Transaction numbers are only allowed|replica set|mongos/i.test(error.message)) {
    return new OrderWorkflowError(503, "TRANSACTIONS_REQUIRED", "Order exception handling requires MongoDB running as a replica set or sharded cluster.");
  }
  return error;
}

async function runTransaction(connection, callback) {
  const session = await connection.startSession();
  try {
    return await session.withTransaction(() => callback(session));
  } catch (error) {
    throw transactionError(error);
  } finally {
    await session.endSession();
  }
}

async function releaseSubOrderReservation({ child, session, ProductModel, SubOrderModel }) {
  if (child.reservationStatus === "released" || child.reservationStatus === "consumed") return;
  for (const item of child.items) {
    if (item.reservationStatus === "released" || item.reservationStatus === "consumed") continue;
    const result = await ProductModel.updateOne({ _id: item.productId, storeId: child.storeId }, {
      $inc: { stockQuantity: item.quantity },
    }, { session });
    if ((result.modifiedCount ?? result.nModified) !== 1) {
      throw new OrderWorkflowError(409, "RESERVATION_RELEASE_FAILED", "Reserved inventory could not be restored; no order changes were committed.");
    }
    item.reservationStatus = "released";
  }
  const now = new Date();
  const result = await SubOrderModel.updateOne({ _id: child._id }, {
    $set: { items: child.items, reservationStatus: "released", reservationReleasedAt: now },
  }, { session });
  if ((result.modifiedCount ?? result.nModified) !== 1) {
    throw new OrderWorkflowError(409, "ORDER_CHANGED", "Order reservation state changed. Refresh and try again.");
  }
}

export async function reportUnavailableItem({
  storeDbId, subOrderId, productId, reason, StoreModel, SubOrderModel = SubOrder,
  ParentOrderModel = ParentOrder, ProductModel = Product, connection = mongoose.connection,
}) {
  if (!validReason(reason)) throw new OrderWorkflowError(400, "INVALID_EXCEPTION_REASON", "A reason of 1 to 500 characters is required.");
  let saved;
  await runTransaction(connection, async (session) => {
    const child = await SubOrderModel.findOne({ ...orderLookup(subOrderId), storeId: storeDbId }).session(session).lean();
    if (!child) throw new OrderWorkflowError(404, "SUB_ORDER_NOT_FOUND", "Order not found for this supermarket.");
    const parent = await ParentOrderModel.findById(child.parentOrderId).session(session).lean();
    if (!parent) throw new OrderWorkflowError(404, "ORDER_NOT_FOUND", "Parent order not found.");
    ensurePaid(parent);
    if (!['pending_fulfilment', 'accepted', 'preparing'].includes(child.status)) {
      throw new OrderWorkflowError(409, "ORDER_NOT_ELIGIBLE", "Items can only be reported unavailable before dispatch.");
    }
    if (parent.customerAction?.decision === "pending") {
      throw new OrderWorkflowError(409, "CUSTOMER_DECISION_PENDING", "Wait for the customer's current order decision before reporting another exception.");
    }
    const item = child.items.find((line) => line.productKey === productId || String(line.productId) === productId);
    if (!item) throw new OrderWorkflowError(404, "ORDER_ITEM_NOT_FOUND", "This product is not part of the supermarket order.");
    if (item.fulfilmentStatus === "unavailable") {
      throw new OrderWorkflowError(409, "ITEM_ALREADY_UNAVAILABLE", "This order item has already been reported unavailable.");
    }
    if (["fulfilled"].includes(item.fulfilmentStatus)) {
      throw new OrderWorkflowError(409, "ITEM_ALREADY_FULFILLED", "A fulfilled order item cannot be reported unavailable.");
    }

    const now = new Date();
    item.fulfilmentStatus = "unavailable";
    item.unavailableReason = reason.trim();
    item.unavailableAt = now;
    item.refundAmountKobo = item.lineTotalKobo;
    item.refundStatus = "pending";
    item.auditEvents = [...(item.auditEvents ?? []), { type: "unavailable_reported", reason: reason.trim(), at: now }];
    if (item.reservationStatus !== "released" && item.reservationStatus !== "consumed") {
      const restored = await ProductModel.updateOne({ _id: item.productId, storeId: child.storeId }, {
        $inc: { stockQuantity: item.quantity },
        $set: { isAvailable: false },
      }, { session });
      if ((restored.modifiedCount ?? restored.nModified) !== 1) {
        throw new OrderWorkflowError(409, "RESERVATION_RELEASE_FAILED", "The unavailable item reservation could not be released; no changes were committed.");
      }
      item.reservationStatus = "released";
    }
    const obligations = [...(parent.refundObligations ?? [])];
    addObligation(obligations, {
      key: `item_unavailable:${child._id}:${String(item.productId)}`,
      kind: "item_unavailable", subOrderId: child._id, storeId: child.storeId,
      storeName: child.storeName, productId: item.productId, productKey: item.productKey,
      productName: item.productName, amountKobo: item.lineTotalKobo,
      status: "pending", reason: reason.trim(), createdAt: now,
    });
    const remaining = child.items.filter((line) => line.fulfilmentStatus !== "unavailable")
      .reduce((sum, line) => sum + line.lineTotalKobo, 0);
    const childWrite = await SubOrderModel.updateOne({ _id: child._id, storeId: storeDbId, status: child.status }, {
      $set: { items: child.items, fulfilmentSubtotalKobo: remaining },
    }, { session });
    if ((childWrite.modifiedCount ?? childWrite.nModified) !== 1) {
      throw new OrderWorkflowError(409, "ORDER_CHANGED", "The order changed while reporting the unavailable item.");
    }
    const parentWrite = await ParentOrderModel.updateOne({ _id: parent._id, paymentStatus: "paid" }, {
      $set: { refundObligations: obligations },
    }, { session });
    if ((parentWrite.modifiedCount ?? parentWrite.nModified) !== 1) {
      throw new OrderWorkflowError(409, "ORDER_CHANGED", "The parent order changed while recording the refund obligation.");
    }
    saved = { subOrderNumber: child.subOrderNumber, productId: item.productKey, refundAmountKobo: item.lineTotalKobo, refundStatus: "pending", remainingMerchandiseKobo: remaining };
  });
  return saved;
}

export async function requestStoreCannotFulfil({
  storeDbId, subOrderId, reason, SubOrderModel = SubOrder, ParentOrderModel = ParentOrder,
  connection = mongoose.connection,
}) {
  if (!validReason(reason)) throw new OrderWorkflowError(400, "INVALID_EXCEPTION_REASON", "A reason of 1 to 500 characters is required.");
  let result;
  await runTransaction(connection, async (session) => {
    const child = await SubOrderModel.findOne({ ...orderLookup(subOrderId), storeId: storeDbId }).session(session).lean();
    if (!child) throw new OrderWorkflowError(404, "SUB_ORDER_NOT_FOUND", "Order not found for this supermarket.");
    const parent = await ParentOrderModel.findById(child.parentOrderId).session(session).lean();
    if (!parent) throw new OrderWorkflowError(404, "ORDER_NOT_FOUND", "Parent order not found.");
    ensurePaid(parent);
    if (!['pending_fulfilment', 'accepted', 'preparing'].includes(child.status)) {
      throw new OrderWorkflowError(409, "ORDER_NOT_ELIGIBLE", "This store order can no longer request a customer decision.");
    }
    if (parent.customerAction?.decision === "pending") {
      throw new OrderWorkflowError(409, "CUSTOMER_DECISION_PENDING", "A customer decision is already pending for this parent order.");
    }
    const now = new Date();
    const action = {
      reason: reason.trim(), affectedSubOrderId: child._id, affectedStoreId: child.storeId,
      affectedStoreName: child.storeName, amountKobo: child.totalKobo,
      requestedAt: now, decision: "pending", decidedAt: null,
    };
    const childAction = await SubOrderModel.updateOne({ _id: child._id, storeId: storeDbId, status: child.status }, {
      $set: { status: "customer_action_required", customerAction: action },
    }, { session });
    if ((childAction.modifiedCount ?? childAction.nModified) !== 1) throw new OrderWorkflowError(409, "ORDER_CHANGED", "The order changed. Refresh and try again.");
    const history = [...(parent.customerActionHistory ?? []), { ...action, affectedSubOrderNumber: child.subOrderNumber }];
    const parentAction = await ParentOrderModel.updateOne({ _id: parent._id, paymentStatus: "paid" }, {
      $set: { status: "customer_action_required", customerAction: action, customerActionHistory: history },
    }, { session });
    if ((parentAction.modifiedCount ?? parentAction.nModified) !== 1) throw new OrderWorkflowError(409, "CUSTOMER_DECISION_PENDING", "A customer decision is already pending for this parent order.");
    result = { subOrderNumber: child.subOrderNumber, parentOrderNumber: parent.orderNumber, customerAction: action };
  });
  return result;
}

export async function getCustomerActionRequest({ orderId, customerClerkUserId, ParentOrderModel = ParentOrder, SubOrderModel = SubOrder }) {
  const query = /^[a-f\d]{24}$/i.test(orderId) ? { _id: orderId } : { orderNumber: orderId };
  const parent = await ParentOrderModel.findOne({ ...query, customerClerkUserId }).lean();
  if (!parent) return null;
  if (parent.customerAction?.decision !== "pending" || !parent.customerAction?.affectedSubOrderId) {
    throw new OrderWorkflowError(404, "NO_PENDING_CUSTOMER_ACTION", "There is no pending supermarket decision for this order.");
  }
  const child = await SubOrderModel.findOne({ _id: parent.customerAction.affectedSubOrderId, parentOrderId: parent._id }).lean();
  if (!child) throw new OrderWorkflowError(409, "ORDER_DATA_INCONSISTENT", "The affected supermarket order could not be found.");
  return {
    orderNumber: parent.orderNumber,
    status: parent.status,
    paymentStatus: parent.paymentStatus,
    decision: parent.customerAction.decision,
    reason: parent.customerAction.reason,
    affectedSubOrderNumber: child.subOrderNumber,
    affectedStoreId: child.storeSlug,
    affectedStoreName: child.storeName,
    amountKobo: parent.customerAction.amountKobo,
    createdAt: parent.customerAction.requestedAt,
  };
}

export async function decideCustomerAction({
  orderId, customerClerkUserId, decision, ParentOrderModel = ParentOrder, SubOrderModel = SubOrder,
  ProductModel = Product, connection = mongoose.connection,
}) {
  if (!["proceed_remaining", "cancel_remaining"].includes(decision)) {
    throw new OrderWorkflowError(400, "INVALID_CUSTOMER_DECISION", "decision must be proceed_remaining or cancel_remaining.");
  }
  const idQuery = /^[a-f\d]{24}$/i.test(orderId) ? { _id: orderId } : { orderNumber: orderId };
  let found = false;
  await runTransaction(connection, async (session) => {
    const parent = await ParentOrderModel.findOne({ ...idQuery, customerClerkUserId }).session(session).lean();
    if (!parent) return;
    found = true;
    if (parent.customerAction?.decision === decision) return; // idempotent retry
    if (parent.customerAction?.decision !== "pending" || !parent.customerAction?.affectedSubOrderId) {
      throw new OrderWorkflowError(409, "CUSTOMER_DECISION_ALREADY_PROCESSED", "This customer decision has already been processed and cannot be changed.");
    }
    ensurePaid(parent);
    const children = await SubOrderModel.find({ parentOrderId: parent._id }).session(session).lean();
    const affected = children.find((child) => String(child._id) === String(parent.customerAction.affectedSubOrderId));
    if (!affected || affected.status !== "customer_action_required") {
      throw new OrderWorkflowError(409, "ORDER_CHANGED", "The affected store order is no longer awaiting a decision.");
    }
    const now = new Date();
    const obligations = [...(parent.refundObligations ?? [])];
    const canceledChildren = decision === "proceed_remaining"
      ? [affected]
      : children.filter((child) => !["delivered", "dispatched", "cancelled"].includes(child.status));
    for (const child of canceledChildren) {
      const alreadyObligated = sumPendingObligations(obligations, child._id);
      const amount = Math.max(0, child.totalKobo - alreadyObligated);
      if (amount > 0) addObligation(obligations, {
        key: `${decision === "proceed_remaining" ? "store_cancelled" : "parent_cancelled"}:${child._id}`,
        kind: decision === "proceed_remaining" ? "store_cancelled" : "parent_cancelled",
        subOrderId: child._id, storeId: child.storeId, storeName: child.storeName,
        productId: null, productKey: "", productName: "", amountKobo: amount, status: "pending",
        reason: decision === "proceed_remaining" ? parent.customerAction.reason : "Customer rejected continuation and cancelled the remaining order.",
        createdAt: now,
      });
      await releaseSubOrderReservation({ child, session, ProductModel, SubOrderModel });
      const cancellationReason = decision === "proceed_remaining"
        ? parent.customerAction.reason
        : "Customer rejected continuation and cancelled the remaining order.";
      const updated = await SubOrderModel.updateOne({ _id: child._id, parentOrderId: parent._id, status: child.status }, {
        $set: {
          status: "cancelled",
          cancellation: { reason: cancellationReason, cancelledAt: now, cancelledBy: "customer" },
          ...(String(child._id) === String(affected._id) ? { customerAction: { ...child.customerAction, decision, decidedAt: now } } : {}),
        },
      }, { session });
      if ((updated.modifiedCount ?? updated.nModified) !== 1) throw new OrderWorkflowError(409, "ORDER_CHANGED", "A supermarket order changed while applying the decision.");
    }
    const updatedChildren = await SubOrderModel.find({ parentOrderId: parent._id }).session(session).select("status").lean();
    const nextStatus = decision === "cancel_remaining" ? "cancelled" : deriveParentOrderStatus("paid", updatedChildren.map((child) => child.status));
    const history = [...(parent.customerActionHistory ?? [])];
    const currentHistoryIndex = history.map((entry) => String(entry.affectedSubOrderId)).lastIndexOf(String(affected._id));
    if (currentHistoryIndex >= 0) history[currentHistoryIndex] = { ...history[currentHistoryIndex], decision, decidedAt: now };
    const action = { ...parent.customerAction, decision, decidedAt: now };
    const parentUpdate = {
      status: nextStatus, customerAction: action, customerActionHistory: history,
      refundObligations: obligations,
    };
    if (decision === "cancel_remaining") {
      parentUpdate.cancelledAt = now;
      parentUpdate.cancellationReason = "Customer rejected continuation and cancelled the remaining order.";
      parentUpdate.reservationStatus = "released";
      parentUpdate.reservationReleasedAt = now;
    }
    const updatedParent = await ParentOrderModel.updateOne({ _id: parent._id, customerClerkUserId }, { $set: parentUpdate }, { session });
    if ((updatedParent.modifiedCount ?? updatedParent.nModified) !== 1) throw new OrderWorkflowError(409, "CUSTOMER_DECISION_ALREADY_PROCESSED", "This decision was processed by another request.");
  });
  if (!found) return null;
  const orderQuery = /^[a-f\d]{24}$/i.test(orderId) ? { _id: orderId } : { orderNumber: orderId };
  const parent = await ParentOrderModel.findOne({ ...orderQuery, customerClerkUserId }).lean();
  const children = await SubOrderModel.find({ parentOrderId: parent._id }).sort({ createdAt: 1 }).lean();
  return publicParentOrder(parent, children);
}
