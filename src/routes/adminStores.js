import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { AdminAudit } from "../models/AdminAudit.js";
import { Product } from "../models/Product.js";
import { Store } from "../models/Store.js";
import { User } from "../models/User.js";
import { OrderWorkflowError } from "../features/orders/service.js";

export function createAdminStoresRouter({ StoreModel = Store, ProductModel = Product, UserModel = User, AuditModel = AdminAudit, authenticate = requireAuth, authorizeAdmin = requireRoles("admin") } = {}) {
  const router = Router();
  router.use(authenticate, authorizeAdmin);

  router.post("/admin/create-for-owner", asyncHandler(async (req, res) => {
    const allowed = ["ownerEmail", "name", "category", "description", "categories", "address", "openHours"];
    if (!req.body || Object.keys(req.body).some((key) => !allowed.includes(key))) throw new OrderWorkflowError(400, "INVALID_STORE_PROVISION", "Store provisioning contains unsupported fields.");
    const ownerEmail = typeof req.body.ownerEmail === "string" ? req.body.ownerEmail.trim().toLowerCase() : "";
    const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
    const category = typeof req.body.category === "string" ? req.body.category.trim() : "";
    const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
    const openHours = typeof req.body.openHours === "string" ? req.body.openHours.trim() : "";
    const address = req.body.address ?? {};
    const categories = req.body.categories ?? [];
    if (!/^\S+@\S+\.\S+$/.test(ownerEmail) || ownerEmail.length > 254 || !name || name.length > 120 || !category || category.length > 80 || description.length > 3000 || openHours.length > 200 || !Array.isArray(categories) || categories.length > 12 || categories.some((entry) => typeof entry !== "string" || entry.trim().length > 80) || !address || typeof address !== "object" || Array.isArray(address) || Object.keys(address).some((key) => !["line1", "city", "state", "country"].includes(key)) || [address.line1, address.city, address.state, address.country].some((entry) => entry !== undefined && (typeof entry !== "string" || entry.length > 300))) throw new OrderWorkflowError(400, "INVALID_STORE_PROVISION", "Provide a registered owner's email, store name, category and valid store details.");
    const owner = await UserModel.findOne({ email: ownerEmail });
    if (!owner) throw new OrderWorkflowError(404, "STORE_OWNER_NOT_FOUND", "The owner must have a registered Go-Shopper account.");
    const ownerUserId = String(owner._id);
    if (owner.isSuspended) throw new OrderWorkflowError(409, "SUSPENDED_ACCOUNT", "A suspended user cannot own a store.");
    if (owner.role !== "supermarket" || owner.approvalStatus !== "approved" || !owner.emailVerified || !owner.phoneVerified) throw new OrderWorkflowError(409, "STORE_OWNER_NOT_APPROVED", "The owner must have a verified, admin-approved supermarket account.");
    const slug = `${slugify(name)}-${Date.now().toString(36)}`;
    const store = await StoreModel.create({ ownerUserId, name, slug, category, description, categories: categories.map((entry) => entry.trim()).filter(Boolean), address: { line1: address.line1?.trim() || "", city: address.city?.trim() || "", state: address.state?.trim() || "", country: address.country?.trim() || "Nigeria" }, openHours, isActive: false, isApproved: true, approvalStatus: "approved" });
    const auth = req.auth;
    await AuditModel.create({ actorUserId: auth.userId, action: "store_created_for_owner", targetType: "store", targetId: store.slug, metadata: { ownerUserId, isActive: false } });
    return res.status(201).json({ store: safeStore(store.toObject ? store.toObject() : store) });
  }));

  router.get("/admin/all", asyncHandler(async (req, res) => {
    const { page, limit } = pagination(req.query.page, req.query.limit, 50);
    const filter = {};
    if (req.query.q) filter.name = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 80)), "i");
    if (req.query.approvalStatus) {
      if (!["pending", "approved", "rejected"].includes(String(req.query.approvalStatus))) throw new OrderWorkflowError(400, "INVALID_APPROVAL_STATUS", "Unknown approval status.");
      if (req.query.approvalStatus === "pending") filter.$or = [{ approvalStatus: "pending" }, { approvalStatus: { $exists: false }, isApproved: false }];
      else if (req.query.approvalStatus === "approved") filter.$or = [{ approvalStatus: "approved" }, { approvalStatus: { $exists: false }, isApproved: true }];
      else filter.approvalStatus = String(req.query.approvalStatus);
    }
    if (req.query.status === "active") filter.isActive = true;
    else if (req.query.status === "suspended") filter.isActive = false;
    else if (req.query.status && req.query.status !== "all") throw new OrderWorkflowError(400, "INVALID_STORE_STATUS", "status must be active, suspended, or all.");
    const [rows, total] = await Promise.all([
      StoreModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      StoreModel.countDocuments(filter),
    ]);
    const ownerIds = [...new Set(rows.map((store) => store.ownerUserId).filter(Boolean))];
    const owners = ownerIds.length ? await UserModel.find({ _id: { $in: ownerIds } }).select("firstName lastName email phone").lean() : [];
    const ownerMap = new Map(owners.map((owner) => [String(owner._id), safeOwner(owner)]));
    const stores = rows.map((store) => ({ ...safeStore(store), owner: ownerMap.get(store.ownerUserId) ?? { name: "", email: "", phone: "" } }));
    return res.json({ stores, page, limit, total });
  }));

  router.patch("/admin/:storeId/owner", asyncHandler(async (req, res) => {
    const userId = req.body?.userId;
    if (Object.keys(req.body || {}).some((key) => key !== "userId") || typeof userId !== "string" || !/^[a-f\d]{24}$/i.test(userId)) throw new OrderWorkflowError(400, "INVALID_STORE_OWNER", "Provide a Go-Shopper user ID.");
    const storeFilter = /^[a-f\d]{24}$/i.test(req.params.storeId) ? { _id: req.params.storeId } : { slug: req.params.storeId.toLowerCase() };
    const [store, owner] = await Promise.all([StoreModel.findOne(storeFilter), UserModel.findById(userId).select("role approvalStatus emailVerified phoneVerified isSuspended")]);
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found." } });
    if (!owner || owner.role !== "supermarket" || owner.approvalStatus !== "approved" || !owner.emailVerified || !owner.phoneVerified || owner.isSuspended) throw new OrderWorkflowError(409, "STORE_OWNER_NOT_APPROVED", "The new owner must be a verified, approved supermarket account.");
    const priorOwnerUserId = store.ownerUserId || "";
    store.ownerUserId = String(owner._id); await store.save();
    await AuditModel.create({ actorUserId: req.auth.userId, action: "store_owner_assigned", targetType: "store", targetId: store.slug, metadata: { priorOwnerUserId, ownerUserId: String(owner._id) } });
    return res.json({ store: safeStore(store.toObject ? store.toObject() : store) });
  }));

  router.patch("/admin/:storeId/approval", asyncHandler(async (req, res) => {
    const decision = req.body?.decision ?? (req.body?.isApproved === true ? "approved" : req.body?.isApproved === false ? "rejected" : undefined);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (Object.keys(req.body || {}).some((key) => !["decision", "isApproved", "reason"].includes(key)) || !["approved", "rejected"].includes(decision)) throw new OrderWorkflowError(400, "INVALID_APPROVAL", "decision must be approved or rejected.");
    if (decision === "rejected" && !reason) throw new OrderWorkflowError(400, "REJECTION_REASON_REQUIRED", "A reason is required when rejecting a store.");
    if (reason.length > 500) throw new OrderWorkflowError(400, "INVALID_APPROVAL_REASON", "Reason must be at most 500 characters.");
    const store = await findStore(StoreModel, req.params.storeId);
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
    if (store.approvalStatus !== "pending" && !(store.approvalStatus == null && !store.isApproved)) throw new OrderWorkflowError(409, "STORE_NOT_PENDING", "Only a pending application can be approved or rejected.");
    const auth = req.auth;
    const updated = await StoreModel.findByIdAndUpdate(store._id, { $set: {
      isApproved: decision === "approved", approvalStatus: decision,
      approvalReason: decision === "rejected" ? reason : "",
    } }, { new: true, runValidators: true });
    await AuditModel.create({ actorUserId: auth.userId, action: `store_${decision}`, targetType: "store", targetId: store.slug, reason, metadata: { approvalStatus: decision } });
    return res.json({ store: safeStore(updated.toObject()) });
  }));

  router.patch("/admin/:storeId/status", asyncHandler(async (req, res) => {
    if (Object.keys(req.body || {}).some((key) => !["isActive", "reason"].includes(key)) || typeof req.body?.isActive !== "boolean") throw new OrderWorkflowError(400, "INVALID_STORE_STATUS", "isActive must be true or false.");
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if ((!req.body.isActive && !reason) || reason.length > 500) throw new OrderWorkflowError(400, "INVALID_SUSPENSION_REASON", "A suspension reason of at most 500 characters is required.");
    const store = await findStore(StoreModel, req.params.storeId);
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
    if (req.body.isActive && !store.isApproved) throw new OrderWorkflowError(409, "STORE_NOT_APPROVED", "A store must be approved before it can be reactivated.");
    const auth = req.auth;
    const updated = await StoreModel.findByIdAndUpdate(store._id, { $set: {
      isActive: req.body.isActive, suspensionReason: req.body.isActive ? "" : reason,
      suspendedAt: req.body.isActive ? null : new Date(),
    } }, { new: true, runValidators: true });
    await AuditModel.create({ actorUserId: auth.userId, action: req.body.isActive ? "store_reactivated" : "store_suspended", targetType: "store", targetId: store.slug, reason, metadata: { isActive: req.body.isActive } });
    return res.json({ store: safeStore(updated.toObject()) });
  }));

  router.get("/admin/:storeId/products", asyncHandler(async (req, res) => {
    const store = await findStore(StoreModel, req.params.storeId);
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
    const products = await ProductModel.find({ storeId: store._id }).sort({ name: 1 }).limit(500).lean();
    return res.json({ products: products.map((product) => ({
      id: product.productKey, productKey: product.productKey, name: product.name,
      description: product.description, category: product.category, imageUrl: product.imageUrl,
      priceKobo: product.priceKobo, stockQuantity: product.stockQuantity, isAvailable: product.isAvailable,
      createdAt: product.createdAt, updatedAt: product.updatedAt,
    })) });
  }));

  router.get("/admin/:storeId", asyncHandler(async (req, res) => {
    const store = await findStore(StoreModel, req.params.storeId);
    if (!store) return res.status(404).json({ error: { code: "STORE_NOT_FOUND", message: "Store not found" } });
    const [owner, productCount] = await Promise.all([
      UserModel.findById(store.ownerUserId).select("firstName lastName email phone").lean(),
      ProductModel.countDocuments({ storeId: store._id }),
    ]);
    return res.json({ store: { ...safeStore(store), owner: owner ? safeOwner(owner) : null, productCount } });
  }));

  return router;
}

function safeStore(store) {
  return {
    id: store.slug, slug: store.slug, name: store.name, category: store.category,
    tagline: store.tagline, description: store.description, logoUrl: store.logoUrl,
    coverImageUrl: store.coverImageUrl, address: store.address, openHours: store.openHours,
    isActive: store.isActive, isApproved: store.isApproved,
    approvalStatus: store.approvalStatus ?? (store.isApproved ? "approved" : "pending"),
    approvalReason: store.approvalReason ?? "", suspensionReason: store.suspensionReason ?? "",
    suspendedAt: store.suspendedAt ?? null, createdAt: store.createdAt,
  };
}
function safeOwner(owner) { return { name: [owner.firstName, owner.lastName].filter(Boolean).join(" "), email: owner.email, phone: owner.phone }; }
function pagination(rawPage, rawLimit, defaultLimit) {
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const limit = rawLimit === undefined ? defaultLimit : Number(rawLimit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100.");
  return { page, limit };
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function findStore(StoreModel, key) { const filter = /^[a-f\d]{24}$/i.test(key) ? { _id: key } : { slug: key.toLowerCase() }; return StoreModel.findOne(filter).lean(); }
function slugify(value) { return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "store"; }
