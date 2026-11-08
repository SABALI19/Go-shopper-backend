import { Router } from "express";
import { getAuth } from "@clerk/express";
import { User } from "../models/User.js";
import { ParentOrder } from "../models/ParentOrder.js";
import { SubOrder } from "../models/SubOrder.js";
import { AdminAudit } from "../models/AdminAudit.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles, roleFromClaims } from "../middleware/auth.js";
import { publicParentOrder, OrderWorkflowError } from "../features/orders/service.js";

export function createUsersRouter({ UserModel = User, ParentOrderModel = ParentOrder, SubOrderModel = SubOrder, AuditModel = AdminAudit, authenticate = requireAuth, authorizeAdmin = requireRoles("admin"), adminEmail = process.env.ADMIN_EMAIL || "" } = {}) {
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
    if (req.query.q) {
      const regex = new RegExp(escapeRegex(String(req.query.q).trim().slice(0, 80)), "i");
      filter.$or = [{ firstName: regex }, { lastName: regex }, { email: regex }, { phone: regex }];
    }
    const [users, total] = await Promise.all([
      UserModel.find(filter).select("firstName lastName email phone role isSuspended suspensionReason suspendedAt createdAt").sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      UserModel.countDocuments(filter),
    ]);
    return res.json({ users: users.map(safeAdminUser), page, limit, total });
  }));

  router.get("/admin/:userId/orders", authorizeAdmin, asyncHandler(async (req, res) => {
    const user = await findAdminUser(UserModel, req.params.userId);
    if (!user) return res.status(404).json({ error: { code: "USER_NOT_FOUND", message: "User not found" } });
    const { page, limit } = pagination(req.query.page, req.query.limit, 20);
    const [parents, total] = await Promise.all([
      ParentOrderModel.find({ customerClerkUserId: user.clerkUserId }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      ParentOrderModel.countDocuments({ customerClerkUserId: user.clerkUserId }),
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
    if (target.role === "admin") return res.status(409).json({ error: { code: "ADMIN_ACCOUNT_PROTECTED", message: "Administrator accounts cannot be suspended through customer management." } });
    const auth = req.auth || getAuth(req);
    const user = await UserModel.findByIdAndUpdate(target._id, { $set: {
      isSuspended: req.body.isSuspended, suspensionReason: req.body.isSuspended ? reason : "",
      suspendedAt: req.body.isSuspended ? new Date() : null,
    } }, { new: true, runValidators: true });
    const action = req.body.isSuspended ? "user_suspended" : "user_reactivated";
    await AuditModel.create({ actorClerkUserId: auth.userId, action, targetType: "user", targetId: String(user._id), reason, metadata: { role: user.role, isSuspended: user.isSuspended } });
    return res.json({ user: safeAdminUser(user.toObject ? user.toObject() : user) });
  }));

  router.post("/sync", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req);
    const clerkUser = await req.app.locals.clerkClient.users.getUser(auth.userId);
    const primaryEmailEntry = clerkUser.emailAddresses?.find((entry) => entry.id === clerkUser.primaryEmailAddressId);
    const primaryEmail = primaryEmailEntry?.emailAddress || "";
    let role = ["customer", "supermarket", "rider", "admin"].includes(clerkUser.publicMetadata?.role) ? clerkUser.publicMetadata.role : roleFromClaims(auth.sessionClaims);
    const configuredAdminEmail = String(adminEmail).trim().toLowerCase();
    if (configuredAdminEmail && primaryEmail.toLowerCase() === configuredAdminEmail && primaryEmailEntry?.verification?.status === "verified") {
      if (clerkUser.publicMetadata?.role !== "admin") {
        await req.app.locals.clerkClient.users.updateUserMetadata(auth.userId, {
          publicMetadata: { ...(clerkUser.publicMetadata || {}), role: "admin" },
        });
      }
      role = "admin";
    }
    const update = {
      email: primaryEmail,
      phone: clerkUser.phoneNumbers?.find((entry) => entry.id === clerkUser.primaryPhoneNumberId)?.phoneNumber || "",
      firstName: clerkUser.firstName || "",
      lastName: clerkUser.lastName || "",
      role,
    };
    const user = await UserModel.findOneAndUpdate({ clerkUserId: auth.userId }, { $set: update, $setOnInsert: { clerkUserId: auth.userId } }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
    return res.json({ user });
  }));

  router.get("/me", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req);
    const user = await UserModel.findOne({ clerkUserId: auth.userId }).lean();
    return res.json({ user: user || null });
  }));

  router.patch("/me", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req);
    const allowed = ["firstName", "lastName", "phone"];
    const update = Object.fromEntries(allowed.filter((key) => typeof req.body?.[key] === "string").map((key) => [key, req.body[key].trim()]));
    const user = await UserModel.findOneAndUpdate({ clerkUserId: auth.userId }, { $set: update, $setOnInsert: { clerkUserId: auth.userId } }, { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true });
    return res.json({ user });
  }));
  return router;
}

export const usersRouter = createUsersRouter();

async function findAdminUser(UserModel, id) {
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  return UserModel.findById(id).select("firstName lastName email phone role isSuspended suspensionReason suspendedAt createdAt clerkUserId").lean();
}
function safeAdminUser(user) {
  return { id: String(user._id), firstName: user.firstName, lastName: user.lastName, email: user.email, phone: user.phone, role: user.role, isSuspended: user.isSuspended ?? false, suspensionReason: user.suspensionReason ?? "", suspendedAt: user.suspendedAt ?? null, createdAt: user.createdAt };
}
function pagination(rawPage, rawLimit, defaultLimit) {
  const page = rawPage === undefined ? 1 : Number(rawPage);
  const limit = rawLimit === undefined ? defaultLimit : Number(rawLimit);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive and limit must be from 1 to 100.");
  return { page, limit };
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
