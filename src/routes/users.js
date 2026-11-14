import { Router } from "express";
import { User } from "../models/User.js";
import { UserSession } from "../models/UserSession.js";
import { ParentOrder } from "../models/ParentOrder.js";
import { SubOrder } from "../models/SubOrder.js";
import { AdminAudit } from "../models/AdminAudit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { publicParentOrder, OrderWorkflowError } from "../features/orders/service.js";

export function createUsersRouter({ UserModel = User, ParentOrderModel = ParentOrder, SubOrderModel = SubOrder, AuditModel = AdminAudit, SessionModel = UserSession, authenticate = requireAuth, authorizeAdmin = requireRoles("admin") } = {}) {
  const router = Router();
  router.use(authenticate);

  router.get("/", authorizeAdmin, asyncHandler(async (req, res) => {
    const { page, limit } = pagination(req.query.page, req.query.limit, 50);
    const filter = {};
    if (req.query.role) {
      if (!["customer", "supermarket", "rider", "admin"].includes(String(req.query.role))) throw new OrderWorkflowError(400, "INVALID_ROLE_FILTER", "Unknown user role.");
      filter.role = String(req.query.role);
    }
    if (req.query.status === "suspended") filter.isSuspended = true;
    else if (req.query.status === "active") filter.isSuspended = { $ne: true };
    else if (req.query.status && req.query.status !== "all") throw new OrderWorkflowError(400, "INVALID_ACCOUNT_STATUS", "status must be active, suspended, or all.");
    if (req.query.q) { const regex = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 80)), "i"); filter.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }, { phone: regex }]; }
    const [users, total] = await Promise.all([
      UserModel.find(filter).select("firstName lastName email emailVerified phone phoneVerified role approvalStatus isSuspended suspensionReason suspendedAt createdAt").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      UserModel.countDocuments(filter),
    ]);
    return res.json({ users: users.map(safeAdminUser), page, limit, total });
  }));

  router.get("/admin/:userId/orders", authorizeAdmin, asyncHandler(async (req, res) => {
    const user = await findAdminUser(UserModel, req.params.userId);
    if (!user) return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
    const { page, limit } = pagination(req.query.page, req.query.limit, 20);
    const [parents, total] = await Promise.all([
      ParentOrderModel.find({ customerUserId: String(user._id) }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ParentOrderModel.countDocuments({ customerUserId: String(user._id) }),
    ]);
    const children = parents.length ? await SubOrderModel.find({ parentOrderId: { $in: parents.map((parent) => parent._id) } }).sort({ createdAt: 1 }).lean() : [];
    return res.json({ orders: parents.map((parent) => publicParentOrder(parent, children.filter((child) => String(child.parentOrderId) === String(parent._id)))), page, limit, total });
  }));

  router.get("/admin/:userId", authorizeAdmin, asyncHandler(async (req, res) => {
    const user = await findAdminUser(UserModel, req.params.userId);
    if (!user) return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
    return res.json({ user: safeAdminUser(user) });
  }));

  router.patch("/admin/:userId/status", authorizeAdmin, asyncHandler(async (req, res) => {
    if (Object.keys(req.body || {}).some((key) => !["isSuspended", "reason"].includes(key)) || typeof req.body?.isSuspended !== "boolean") throw new OrderWorkflowError(400, "INVALID_ACCOUNT_STATUS", "isSuspended must be true or false.");
    const reason = typeof req.body.reason === "string" ? req.body.reason.trim() : "";
    if (reason.length > 500 || (req.body.isSuspended && !reason)) throw new OrderWorkflowError(400, "INVALID_SUSPENSION_REASON", "A suspension reason of at most 500 characters is required.");
    const target = await findAdminUser(UserModel, req.params.userId);
    if (!target) return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
    if (target.role === "admin") throw new OrderWorkflowError(409, "ADMIN_ACCOUNT_PROTECTED", "Administrator accounts cannot be suspended through customer management.");
    const user = await UserModel.findByIdAndUpdate(target._id, { $set: { isSuspended: req.body.isSuspended, suspensionReason: req.body.isSuspended ? reason : "", suspendedAt: req.body.isSuspended ? new Date() : null } }, { new: true, runValidators: true });
    if (req.body.isSuspended) {
      await SessionModel.updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: new Date() } });
    }
    await AuditModel.create({ actorUserId: req.auth.userId, action: req.body.isSuspended ? "user_suspended" : "user_reactivated", targetType: "user", targetId: String(user._id), reason, metadata: { role: user.role, isSuspended: user.isSuspended } });
    return res.json({ user: safeAdminUser(user.toObject ? user.toObject() : user) });
  }));

  router.get("/me", asyncHandler(async (req, res) => {
    const user = await UserModel.findById(req.auth.userId).lean();
    return res.json({ user: user ? publicUser(user) : null });
  }));
  router.patch("/me", asyncHandler(async (req, res) => {
    const allowed = ["firstName", "lastName"];
    if (Object.keys(req.body || {}).some((key) => !allowed.includes(key))) throw new OrderWorkflowError(400, "INVALID_PROFILE", "Only firstName and lastName can be updated here.");
    const update = Object.fromEntries(allowed.filter((key) => typeof req.body?.[key] === "string").map((key) => [key, req.body[key].trim()]));
    if (!update.firstName || update.firstName.length > 60 || (update.lastName && update.lastName.length > 60)) throw new OrderWorkflowError(400, "INVALID_PROFILE", "Enter a valid name.");
    const user = await UserModel.findByIdAndUpdate(req.auth.userId, { $set: update }, { new: true });
    return res.json({ user: publicUser(user) });
  }));
  return router;
}

export const usersRouter = createUsersRouter();

async function findAdminUser(UserModel, id) { return /^[a-f\d]{24}$/i.test(id) ? UserModel.findById(id).select("firstName lastName email emailVerified phone phoneVerified role approvalStatus isSuspended suspensionReason suspendedAt createdAt").lean() : null; }
function safeAdminUser(user) { return { id: String(user._id), firstName: user.firstName, lastName: user.lastName, email: user.email, emailVerified: Boolean(user.emailVerified), phone: user.phone, phoneVerified: Boolean(user.phoneVerified), role: user.role, approvalStatus: user.approvalStatus, isSuspended: user.isSuspended ?? false, suspensionReason: user.suspensionReason ?? "", suspendedAt: user.suspendedAt ?? null, createdAt: user.createdAt }; }
function publicUser(user) { return { id: String(user._id), firstName: user.firstName, lastName: user.lastName, email: user.email, emailVerified: Boolean(user.emailVerified), phone: user.phone, phoneVerified: Boolean(user.phoneVerified), role: user.role, approvalStatus: user.approvalStatus, isSuspended: Boolean(user.isSuspended) }; }
function pagination(rawPage, rawLimit, defaultLimit) { const page = rawPage === undefined ? 1 : Number(rawPage); const limit = rawLimit === undefined ? defaultLimit : Number(rawLimit); if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page and limit must be positive; limit may not exceed 100."); return { page, limit }; }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
