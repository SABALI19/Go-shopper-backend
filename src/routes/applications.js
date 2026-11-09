import { Router } from "express";
import { getAuth } from "@clerk/express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";
import { OnboardingApplication } from "../models/OnboardingApplication.js";
import { User } from "../models/User.js";
import { Store } from "../models/Store.js";
import { AdminAudit } from "../models/AdminAudit.js";
import { OrderWorkflowError } from "../features/orders/service.js";
import { sendApplicationConfirmation } from "../services/applicationEmail.js";

const statuses = ["pending_review", "under_review", "needs_information", "approved", "rejected", "withdrawn"];
export function createApplicationsRouter({ ApplicationModel = OnboardingApplication, UserModel = User, authenticate = requireAuth } = {}) {
  const router = Router(); router.use(authenticate);
  router.post("/:type", asyncHandler(async (req, res) => {
    const type = req.params.type;
    if (!["supermarket", "rider"].includes(type)) throw new OrderWorkflowError(404, "APPLICATION_TYPE_NOT_FOUND", "Application type not found.");
    const auth = req.auth || getAuth(req);
    const data = validateData(type, req.body?.data);
    const account = await UserModel.findOne({ clerkUserId: auth.userId }).select("role isSuspended").lean();
    if (account?.isSuspended) throw new OrderWorkflowError(403, "ACCOUNT_SUSPENDED", "This account cannot submit an application.");
    if (account && account.role !== "customer" && !(type === "supermarket" && account.role === "supermarket")) throw new OrderWorkflowError(409, "ROLE_ALREADY_ASSIGNED", "This account already has an operational or administrator role.");
    const clerk = req.app.locals.clerkClient;
    if (clerk?.users?.getUser) {
      const identity = await clerk.users.getUser(auth.userId);
      const primaryEmail = identity.emailAddresses?.find((entry) => entry.id === identity.primaryEmailAddressId);
      if (!primaryEmail || primaryEmail.verification?.status !== "verified" || primaryEmail.emailAddress.toLowerCase() !== data.email.toLowerCase()) throw new OrderWorkflowError(403, "VERIFIED_EMAIL_REQUIRED", "Use the verified primary email address on your Go-Shopper account.");
      data.email = primaryEmail.emailAddress.toLowerCase();
      const primaryPhone = identity.phoneNumbers?.find((entry) => entry.id === identity.primaryPhoneNumberId)?.phoneNumber;
      if (primaryPhone) data.phone = primaryPhone;
      const fullName = [identity.firstName, identity.lastName].filter(Boolean).join(" ");
      if (fullName) data.fullName = fullName;
      await UserModel.findOneAndUpdate({ clerkUserId: auth.userId }, { $set: { email: data.email, ...(primaryPhone ? { phone: primaryPhone } : {}), firstName: identity.firstName || "", lastName: identity.lastName || "" }, $setOnInsert: { clerkUserId: auth.userId } }, { upsert: true, new: true, setDefaultsOnInsert: true });
    }
    const current = await ApplicationModel.findOne({ applicantClerkUserId: auth.userId, type, status: { $in: ["pending_review", "under_review", "needs_information"] } }).lean();
    if (current && current.status !== "needs_information") throw new OrderWorkflowError(409, "APPLICATION_ALREADY_ACTIVE", "You already have an active application of this type.");
    if (current) throw new OrderWorkflowError(409, "RESUBMISSION_REQUIRED", "Update your existing application instead.");
    const reference = `GS-${type === "rider" ? "R" : "S"}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const application = await ApplicationModel.create({ reference, type, applicantClerkUserId: auth.userId, data, status: "pending_review", history: [{ status: "pending_review", actorClerkUserId: auth.userId, message: "Application submitted" }] });
    let confirmationEmailSent = false;
    if (type === "supermarket") {
      try {
        confirmationEmailSent = await sendApplicationConfirmation(application);
      } catch (error) {
        console.error("Could not send supermarket application confirmation email:", error.message);
      }
    }
    return res.status(201).json({ application: publicApplication(application), confirmationEmailSent });
  }));
  router.get("/mine", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req);
    const applications = await ApplicationModel.find({ applicantClerkUserId: auth.userId }).sort({ createdAt: -1 }).lean();
    return res.json({ applications: applications.map(publicApplication) });
  }));
  router.patch("/:applicationId", asyncHandler(async (req, res) => {
    const auth = req.auth || getAuth(req); const application = await ApplicationModel.findOne({ _id: req.params.applicationId, applicantClerkUserId: auth.userId });
    if (!application) return res.status(404).json({ error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." } });
    if (application.status !== "needs_information") throw new OrderWorkflowError(409, "APPLICATION_NOT_EDITABLE", "Only applications requesting more information can be updated.");
    const data = validateData(application.type, req.body?.data);
    const clerk = req.app.locals.clerkClient;
    if (clerk?.users?.getUser) {
      const identity = await clerk.users.getUser(auth.userId);
      const primaryEmail = identity.emailAddresses?.find((entry) => entry.id === identity.primaryEmailAddressId);
      if (!primaryEmail || primaryEmail.verification?.status !== "verified" || primaryEmail.emailAddress.toLowerCase() !== data.email.toLowerCase()) throw new OrderWorkflowError(403, "VERIFIED_EMAIL_REQUIRED", "Use the verified primary email address on your Go-Shopper account.");
      data.email = primaryEmail.emailAddress.toLowerCase();
    }
    application.data = data; application.status = "pending_review"; application.feedback = "";
    application.history.push({ status: "pending_review", actorClerkUserId: auth.userId, message: "Applicant resubmitted requested information" });
    await application.save(); return res.json({ application: publicApplication(application) });
  }));
  return router;
}

export function createAdminApplicationsRouter({ ApplicationModel = OnboardingApplication, StoreModel = Store, UserModel = User, AuditModel = AdminAudit, authenticate = requireAuth, authorizeAdmin } = {}) {
  const router = Router(); router.use(authenticate, authorizeAdmin || ((req, res, next) => next()));
  router.get("/", asyncHandler(async (req, res) => {
    const page = validPage(req.query.page), limit = Math.min(100, validLimit(req.query.limit));
    const filter = {};
    if (req.query.type && ["supermarket", "rider"].includes(String(req.query.type))) filter.type = String(req.query.type);
    if (req.query.status && statuses.includes(String(req.query.status))) filter.status = String(req.query.status);
    if (req.query.q) { const q = escapeRegex(String(req.query.q).slice(0, 80)); filter.$or = [{ reference: new RegExp(q, "i") }, { applicantClerkUserId: new RegExp(q, "i") }, { "data.businessName": new RegExp(q, "i") }, { "data.fullName": new RegExp(q, "i") }]; }
    const [rows, total] = await Promise.all([ApplicationModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), ApplicationModel.countDocuments(filter)]);
    res.json({ applications: rows.map((row) => publicApplication(row, true)), page, limit, total });
  }));
  router.get("/:applicationId", asyncHandler(async (req, res) => {
    const application = await ApplicationModel.findById(req.params.applicationId).lean();
    if (!application) return res.status(404).json({ error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." } });
    const audit = await AuditModel.find({ targetType: "application", targetId: String(application._id) }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ application: publicApplication(application, true), audit: audit.map(({ actorClerkUserId, action, reason, metadata, createdAt }) => ({ actorClerkUserId, action, reason, metadata, createdAt })) });
  }));
  router.patch("/:applicationId/decision", asyncHandler(async (req, res) => {
    const { decision, reason = "", notes = "" } = req.body || {};
    if (!statuses.slice(1, 5).includes(decision) || typeof reason !== "string" || typeof notes !== "string" || reason.length > 1000 || notes.length > 2000 || ((decision === "rejected" || decision === "needs_information") && !reason.trim())) throw new OrderWorkflowError(400, "INVALID_APPLICATION_DECISION", "Choose under_review, needs_information, approved or rejected. A reason is required for requests and rejections.");
    const auth = req.auth || getAuth(req); const application = await ApplicationModel.findById(req.params.applicationId);
    if (!application) return res.status(404).json({ error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." } });
    if (decision === "approved" && application.status === "approved") return res.json({ application: publicApplication(application, true), idempotent: true });
    if (["approved", "rejected", "withdrawn"].includes(application.status)) throw new OrderWorkflowError(409, "APPLICATION_ALREADY_DECIDED", "This application has already been closed.");
    let user = await UserModel.findOne({ clerkUserId: application.applicantClerkUserId });
    if (decision === "approved") {
      if (!user) user = await UserModel.create({ clerkUserId: application.applicantClerkUserId, role: "customer" });
      if (user.isSuspended) throw new OrderWorkflowError(409, "SUSPENDED_ACCOUNT", "A suspended user cannot be provisioned.");
      if (application.type === "supermarket") {
        if (["admin", "rider"].includes(user.role)) throw new OrderWorkflowError(409, "ROLE_CANNOT_BE_CHANGED", "This account cannot be converted to a supermarket account.");
        const slug = `${slugify(application.data.businessName)}-${String(application._id).slice(-6)}`;
        let store = application.provisionedStoreId ? await StoreModel.findById(application.provisionedStoreId) : null;
        if (!store) store = await StoreModel.findOne({ slug });
        if (!store) store = await StoreModel.create({ ownerClerkUserId: application.applicantClerkUserId, name: application.data.businessName, slug, category: application.data.category, description: application.data.description, categories: application.data.categories, address: { line1: application.data.address, city: application.data.city, state: application.data.state, country: "Nigeria", ...(Number.isFinite(application.data.latitude) && Number.isFinite(application.data.longitude) ? { location: { type: "Point", coordinates: [application.data.longitude, application.data.latitude] } } : {}) }, openHours: application.data.operatingHours, isActive: false, isApproved: true, approvalStatus: "approved" });
        application.provisionedStoreId = store._id; user.role = "supermarket"; await user.save();
      } else {
        if (["admin", "supermarket"].includes(user.role)) throw new OrderWorkflowError(409, "ROLE_CANNOT_BE_CHANGED", "This account cannot be converted to a rider.");
        user.role = "rider"; user.riderProfile = { approvalStatus: "approved", vehicleType: application.data.vehicleType || "", isOnline: false, activeDeliveryId: null }; await user.save(); application.provisionedUserId = user._id;
        const clerk = req.app.locals.clerkClient;
        if (!clerk?.users?.getUser || !clerk?.users?.updateUserMetadata) throw new OrderWorkflowError(503, "CLERK_UNAVAILABLE", "Rider approval is temporarily unavailable.");
        const clerkUser = await clerk.users.getUser(application.applicantClerkUserId);
        await clerk.users.updateUserMetadata(application.applicantClerkUserId, { publicMetadata: { ...clerkUser.publicMetadata, role: "rider" } });
      }
    }
    if (decision === "approved" && application.type === "supermarket") {
      const clerk = req.app.locals.clerkClient;
      if (!clerk?.users?.getUser || !clerk?.users?.updateUserMetadata) throw new OrderWorkflowError(503, "CLERK_UNAVAILABLE", "Store owner approval is temporarily unavailable.");
      const clerkUser = await clerk.users.getUser(application.applicantClerkUserId);
      await clerk.users.updateUserMetadata(application.applicantClerkUserId, { publicMetadata: { ...clerkUser.publicMetadata, role: "supermarket" } });
    }
    application.status = decision; application.active = !["approved", "rejected", "withdrawn"].includes(decision); application.feedback = reason.trim(); application.reviewerNotes = notes.trim(); application.reviewedAt = new Date(); application.history.push({ status: decision, actorClerkUserId: auth.userId, message: reason.trim() }); await application.save();
    await AuditModel.create({ actorClerkUserId: auth.userId, action: `application_${decision}`, targetType: "application", targetId: String(application._id), reason: reason.trim(), metadata: { type: application.type, reference: application.reference, reviewerNotes: notes.trim() } });
    res.json({ application: publicApplication(application, true) });
  }));
  return router;
}

export function validateData(type, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OrderWorkflowError(400, "INVALID_APPLICATION", "Application details are required.");
  const allowed = type === "supermarket" ? ["businessName", "legalName", "description", "category", "categories", "registrationNumber", "ownershipRole", "ownershipDeclaration", "fullName", "email", "phone", "address", "city", "state", "latitude", "longitude", "operatingHours", "additionalInformation"] : ["fullName", "email", "phone", "address", "operatingArea", "vehicleType", "licenseInformation", "additionalInformation"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw new OrderWorkflowError(400, "INVALID_APPLICATION_FIELD", "Application contains unsupported fields.");
  const data = {};
  for (const field of allowed) if (input[field] !== undefined) {
    const value = input[field];
    if (field === "categories") {
      if (!Array.isArray(value) || value.length > 12 || value.some((item) => typeof item !== "string" || item.trim().length > 80)) throw new OrderWorkflowError(400, "INVALID_APPLICATION_FIELD", "categories must be a list of up to 12 values.");
      data[field] = value.map((item) => item.trim()).filter(Boolean); continue;
    }
    if (field === "ownershipDeclaration") {
      if (typeof value !== "boolean") throw new OrderWorkflowError(400, "INVALID_APPLICATION_FIELD", "ownershipDeclaration must be true or false.");
      data[field] = value; continue;
    }
    if (field === "latitude" || field === "longitude") {
      if (typeof value !== "number" || !Number.isFinite(value) || (field === "latitude" && (value < -90 || value > 90)) || (field === "longitude" && (value < -180 || value > 180))) throw new OrderWorkflowError(400, "INVALID_APPLICATION_FIELD", `${field} must be a valid map coordinate.`);
      data[field] = value; continue;
    }
    if (typeof value !== "string" || value.trim().length > fieldMax(field)) throw new OrderWorkflowError(400, "INVALID_APPLICATION_FIELD", `${field} must be text up to ${fieldMax(field)} characters.`);
    data[field] = value.trim();
  }
  const required = type === "supermarket" ? ["businessName", "legalName", "fullName", "email", "phone", "category", "description", "address", "city", "state", "operatingHours"] : ["fullName", "email", "phone", "address", "operatingArea", "vehicleType"];
  if (required.some((field) => !data[field])) throw new OrderWorkflowError(400, "APPLICATION_FIELDS_REQUIRED", `Required fields: ${required.join(", ")}.`);
  if (type === "supermarket" && (!data.ownershipDeclaration || !["owner", "authorized_representative"].includes(data.ownershipRole))) throw new OrderWorkflowError(400, "OWNERSHIP_CONFIRMATION_REQUIRED", "Confirm ownership or authorization to represent this supermarket.");
  if (type === "supermarket" && ((data.latitude === undefined) !== (data.longitude === undefined))) throw new OrderWorkflowError(400, "INVALID_STORE_LOCATION", "Both latitude and longitude are required when providing a map location.");
  if (!/^\S+@\S+\.\S+$/.test(data.email)) throw new OrderWorkflowError(400, "INVALID_EMAIL", "Enter a valid email address.");
  return data;
}
function fieldMax(field) { return ({ description: 3000, identityDetails: 500, licenseInformation: 200, additionalInformation: 1000, email: 254, address: 300, fullName: 120, businessName: 120, legalName: 120, operatingHours: 200, registrationNumber: 80, ownershipRole: 32, phone: 32, category: 80, city: 80, state: 80, operatingArea: 120, vehicleType: 80 })[field] || 500; }
function publicApplication(a, admin = false) { const row = a.toObject ? a.toObject() : a; return { id: String(row._id), reference: row.reference, type: row.type, status: row.status, data: row.data, feedback: row.feedback || "", ...(admin ? { reviewerNotes: row.reviewerNotes || "" } : {}), history: (row.history || []).map(({ status, message, createdAt }) => ({ status, message, createdAt })), createdAt: row.createdAt, updatedAt: row.updatedAt, reviewedAt: row.reviewedAt }; }
function validPage(v) { const n = v === undefined ? 1 : Number(v); if (!Number.isSafeInteger(n) || n < 1) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "page must be positive."); return n; }
function validLimit(v) { const n = v === undefined ? 25 : Number(v); if (!Number.isSafeInteger(n) || n < 1) throw new OrderWorkflowError(400, "INVALID_PAGINATION", "limit must be between 1 and 100."); return n; }
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function slugify(s) { return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "store"; }

export const applicationsRouter = createApplicationsRouter();
