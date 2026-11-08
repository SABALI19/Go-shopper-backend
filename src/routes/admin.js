import { Router } from "express";
import { getAuth } from "@clerk/express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { getCheckoutPricing } from "../config/checkoutPricing.js";
import { AdminAudit } from "../models/AdminAudit.js";
import { ParentOrder } from "../models/ParentOrder.js";
import { PlatformSettings } from "../models/PlatformSettings.js";
import { Store } from "../models/Store.js";
import { SubOrder } from "../models/SubOrder.js";
import { User } from "../models/User.js";
import { publicParentOrder, OrderWorkflowError } from "../features/orders/service.js";

export function createAdminRouter({
  UserModel = User, StoreModel = Store, ParentOrderModel = ParentOrder, SubOrderModel = SubOrder,
  AuditModel = AdminAudit, SettingsModel = PlatformSettings, authenticate = requireAuth,
  authorizeAdmin = requireRoles("admin"), pricingProvider = getCheckoutPricing,
} = {}) {
  const router = Router();
  router.use(authenticate, authorizeAdmin);

  router.get("/dashboard/summary", asyncHandler(async (_req, res) => {
    const [registeredCustomers, totalSupermarkets, activeSupermarkets, pendingStoreApprovals, suspendedStores, orderGroups, recentAudits, recentOrders, recentStores, recentUsers] = await Promise.all([
      UserModel.countDocuments({ role: "customer" }),
      StoreModel.countDocuments({}),
      StoreModel.countDocuments({ isApproved: true, isActive: true }),
      StoreModel.countDocuments({ $or: [{ approvalStatus: "pending" }, { approvalStatus: { $exists: false }, isApproved: false }] }),
      StoreModel.countDocuments({ isApproved: true, isActive: false }),
      ParentOrderModel.aggregate([{ $group: { _id: { status: "$status", paymentStatus: "$paymentStatus" }, count: { $sum: 1 } } }]),
      AuditModel.find({}).sort({ createdAt: -1 }).limit(8).lean(),
      ParentOrderModel.find({}).select("orderNumber status paymentStatus createdAt").sort({ createdAt: -1 }).limit(5).lean(),
      StoreModel.find({}).select("slug name approvalStatus isApproved isActive createdAt").sort({ createdAt: -1 }).limit(5).lean(),
      UserModel.find({}).select("firstName lastName role createdAt").sort({ createdAt: -1 }).limit(5).lean(),
    ]);
    const counts = { totalParentOrders: 0, awaitingPaymentOrders: 0, confirmedProcessingOrders: 0, completedOrders: 0, cancelledOrders: 0, customerActionRequiredOrders: 0 };
    for (const group of orderGroups) {
      const status = group._id.status;
      counts.totalParentOrders += group.count;
      if (group._id.paymentStatus === "pending" && status !== "cancelled") counts.awaitingPaymentOrders += group.count;
      if (["confirmed", "processing", "partially_fulfilled"].includes(status)) counts.confirmedProcessingOrders += group.count;
      if (status === "completed") counts.completedOrders += group.count;
      if (status === "cancelled") counts.cancelledOrders += group.count;
      if (status === "customer_action_required") counts.customerActionRequiredOrders += group.count;
    }
    const activity = [
      ...recentAudits.map((entry) => ({ type: "admin_action", action: entry.action, targetType: entry.targetType, targetId: entry.targetId, reason: entry.reason, createdAt: entry.createdAt })),
      ...recentOrders.map((order) => ({ type: "order", action: `Order ${order.status}`, targetType: "order", targetId: order.orderNumber, paymentStatus: order.paymentStatus, createdAt: order.createdAt })),
      ...recentStores.map((store) => ({ type: "store", action: store.approvalStatus ?? (store.isApproved ? "approved" : "pending approval"), targetType: "store", targetId: store.slug, name: store.name, isActive: store.isActive, createdAt: store.createdAt })),
      ...recentUsers.map((user) => ({ type: "user", action: `${user.role} account registered`, targetType: "user", targetId: String(user._id), name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "New account", createdAt: user.createdAt })),
    ].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()).slice(0, 10);
    return res.json({ summary: { registeredCustomers, totalSupermarkets, activeSupermarkets, pendingStoreApprovals, suspendedStores, ...counts }, recentActivity: activity });
  }));

  router.get("/orders", asyncHandler(async (req, res) => {
    const { page, limit } = parsePagination(req.query.page, req.query.limit, 20);
    const filter = {};
    if (req.query.q) filter.orderNumber = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 80)), "i");
    if (req.query.paymentStatus) {
      if (!["pending", "paid", "failed", "refunded"].includes(String(req.query.paymentStatus))) throw new OrderWorkflowError(400, "INVALID_PAYMENT_STATUS", "Unknown payment status.");
      filter.paymentStatus = String(req.query.paymentStatus);
    }
    if (req.query.status) {
      if (!["pending_payment", "confirmed", "processing", "partially_fulfilled", "completed", "cancelled", "customer_action_required"].includes(String(req.query.status))) throw new OrderWorkflowError(400, "INVALID_ORDER_STATUS", "Unknown parent order status.");
      filter.status = String(req.query.status);
    }
    if (req.query.customerActionRequired === "true") filter.status = "customer_action_required";
    if (req.query.storeId) {
      const store = await findStore(StoreModel, String(req.query.storeId));
      if (!store) return res.json({ orders: [], page, limit, total: 0 });
      const parentIds = await SubOrderModel.distinct("parentOrderId", { storeId: store._id });
      filter._id = { $in: parentIds };
    }
    const [parents, total] = await Promise.all([
      ParentOrderModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ParentOrderModel.countDocuments(filter),
    ]);
    const children = parents.length ? await SubOrderModel.find({ parentOrderId: { $in: parents.map((order) => order._id) } }).sort({ createdAt: 1 }).lean() : [];
    const orders = parents.map((parent) => publicAdminOrder(parent, children.filter((child) => String(child.parentOrderId) === String(parent._id))));
    return res.json({ orders, page, limit, total });
  }));

  router.get("/orders/:orderId", asyncHandler(async (req, res) => {
    const query = orderLookup(req.params.orderId);
    const parent = await ParentOrderModel.findOne(query).lean();
    if (!parent) return res.status(404).json({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    const children = await SubOrderModel.find({ parentOrderId: parent._id }).sort({ createdAt: 1 }).lean();
    const customer = await UserModel.findOne({ clerkUserId: parent.customerClerkUserId }).select("firstName lastName email phone role").lean();
    return res.json({ order: { ...publicAdminOrder(parent, children), customer: customer ? safeUser(customer) : null } });
  }));

  router.get("/settings", asyncHandler(async (_req, res) => {
    return res.json({ settings: await readSettings(SettingsModel, pricingProvider) });
  }));

  router.put("/settings", asyncHandler(async (req, res) => {
    const validation = validateSettings(req.body);
    if (validation.error) return res.status(400).json({ error: { code: "INVALID_SETTINGS", message: validation.error } });
    const auth = req.auth || getAuth(req);
    const prior = await SettingsModel.findById("platform").lean();
    const settings = await SettingsModel.findOneAndUpdate({ _id: "platform" }, {
      $set: { ...validation.settings, updatedBy: auth.userId },
    }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
    await AuditModel.create({ actorClerkUserId: auth.userId, action: "platform_settings_updated", targetType: "platform_settings", targetId: "platform", metadata: { before: prior ? pickSettings(prior) : null, after: validation.settings } });
    return res.json({ settings: publicSettings(settings) });
  }));

  return router;
}

export async function readSettings(SettingsModel = PlatformSettings, pricingProvider = getCheckoutPricing) {
  const saved = await SettingsModel.findById("platform").lean();
  return saved ? publicSettings(saved) : { ...pricingProvider(), source: "environment", updatedAt: null };
}

export async function getEffectiveCheckoutPricing(SettingsModel = PlatformSettings, envProvider = getCheckoutPricing) {
  const saved = await SettingsModel.findById("platform").lean();
  if (!saved) return envProvider();
  return { minimumStoreSubtotalKobo: saved.minimumStoreSubtotalKobo, deliveryFeeKobo: saved.deliveryFeeKobo, serviceFeeKobo: saved.serviceFeeKobo };
}

export function validateSettings(body) {
  const fields = ["minimumStoreSubtotalKobo", "deliveryFeeKobo", "serviceFeeKobo"];
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !fields.includes(key))) return { error: "Only minimumStoreSubtotalKobo, deliveryFeeKobo, and serviceFeeKobo are accepted." };
  const settings = {};
  for (const field of fields) {
    const amount = body[field];
    const minimum = field === "minimumStoreSubtotalKobo" ? 1 : 0;
    if (!Number.isSafeInteger(amount) || amount < minimum || amount > 1_000_000_000) return { error: `${field} must be an integer kobo amount between ${minimum} and 1000000000.` };
    settings[field] = amount;
  }
  return { settings };
}

export function safeUser(user) {
  return { id: String(user._id), firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.phone, role: user.role, isSuspended: user.isSuspended ?? false, suspensionReason: user.suspensionReason ?? "", suspendedAt: user.suspendedAt ?? null, createdAt: user.createdAt };
}

function publicSettings(settings) {
  return { minimumStoreSubtotalKobo: settings.minimumStoreSubtotalKobo, deliveryFeeKobo: settings.deliveryFeeKobo, serviceFeeKobo: settings.serviceFeeKobo, source: "database", updatedAt: settings.updatedAt ?? null };
}
function publicAdminOrder(parent, children = []) {
  const order = publicParentOrder(parent, children);
  return {
    ...order,
    subOrders: order.subOrders.map((child, index) => ({
      ...child,
      items: child.items.map((item, itemIndex) => ({
        ...item,
        auditEvents: (children[index]?.items?.[itemIndex]?.auditEvents ?? []).map((event) => ({
          type: event.type, reason: event.reason, at: event.at,
        })),
      })),
    })),
  };
}
function pickSettings(settings) { return { minimumStoreSubtotalKobo: settings.minimumStoreSubtotalKobo, deliveryFeeKobo: settings.deliveryFeeKobo, serviceFeeKobo: settings.serviceFeeKobo }; }
function parsePagination(rawPage, rawLimit, defaultLimit) {
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const limit = rawLimit === undefined ? defaultLimit : Number(rawLimit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100.");
  return { page, limit };
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function orderLookup(value) { return /^[a-f\d]{24}$/i.test(value) ? { _id: value } : { orderNumber: value }; }
async function findStore(StoreModel, key) {
  const filter = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() };
  return StoreModel.findOne(filter).select("_id").lean();
}
