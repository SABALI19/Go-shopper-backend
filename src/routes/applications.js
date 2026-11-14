import { Router } from "express";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth, requireRoles } from "../middleware/auth.js";
import { OnboardingApplication } from "../models/OnboardingApplication.js";
import { User } from "../models/User.js";
import { Store } from "../models/Store.js";
import { AdminAudit } from "../models/AdminAudit.js";
import { OrderWorkflowError } from "../features/orders/service.js";
import { enqueueApplicationEmail } from "../services/applicationNotificationOutbox.js";

const statuses = ["pending_review", "under_review", "needs_information", "approved", "rejected", "withdrawn"];
export function createApplicationsRouter({ ApplicationModel = OnboardingApplication, UserModel = User, authenticate = requireAuth, enqueueNotification = enqueueApplicationEmail } = {}) {
  const router = Router(); router.use(authenticate);
  router.post("/:type", asyncHandler(async (req, res) => {
    const type = req.params.type;
    if (!["supermarket", "rider"].includes(type)) throw new OrderWorkflowError(404, "APPLICATION_TYPE_NOT_FOUND", "Application type not found.");
    const auth = req.auth;
    const data = validateData(type, req.body?.data);
    const account = await UserModel.findById(auth.userId).select("role isSuspended email emailVerified phone phoneVerified firstName lastName").lean();
    if (account?.isSuspended) throw new OrderWorkflowError(403, "ACCOUNT_SUSPENDED", "This account cannot submit an application.");
    if (!account || account.role !== type) throw new OrderWorkflowError(403, "ACCOUNT_TYPE_MISMATCH", "Sign in with the account type for this application.");
    if (!account.emailVerified || !account.phoneVerified) throw new OrderWorkflowError(403, "VERIFICATION_REQUIRED", "Verify your email address and phone number before applying.");
    data.email = account.email; data.phone = account.phone;
    data.fullName = [account.firstName, account.lastName].filter(Boolean).join(" ");
    const current = await ApplicationModel.findOne({ applicantUserId: auth.userId, type, status: { $in: ["pending_review", "under_review", "needs_information"] } }).lean();
    if (current && current.status !== "needs_information") throw new OrderWorkflowError(409, "APPLICATION_ALREADY_ACTIVE", "You already have an active application of this type.");
    if (current) throw new OrderWorkflowError(409, "RESUBMISSION_REQUIRED", "Update your existing application instead.");
    const reference = `GS-${type === "rider" ? "R" : "S"}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const application = await ApplicationModel.create({ reference, type, applicantUserId: auth.userId, data, status: "pending_review", history: [{ status: "pending_review", actorUserId: auth.userId, message: "Application submitted" }] });
    const notificationJobs = [
      enqueueNotification({ key: `${application._id}:applicant:submitted`, kind: `${type}_application_submitted`, to: account.email, subject: "Go-Shopper application received", text: `We received your ${type} application ${reference}.`, html: `<p>We received your ${type} application <strong>${escapeHtml(reference)}</strong>.</p><p>You can follow its progress from your Go-Shopper account.</p>` }),
      enqueueNotification({ key: `${application._id}:admin:submitted`, kind: `${type}_application_admin_notice`, to: process.env.GOSHOPPER_APPLICATION_NOTIFICATION_EMAIL, subject: `New ${type} application`, text: `A new ${type} application ${reference} is ready for review.`, html: `<p>A new ${type} application <strong>${escapeHtml(reference)}</strong> is ready for review.</p>` }),
    ];
    const notificationResults = await Promise.allSettled(notificationJobs);
    return res.status(201).json({ application: publicApplication(application), confirmationEmailSent: false, notificationQueued: notificationResults.some((result) => result.status === "fulfilled" && result.value) });
  }));
  router.get("/mine", asyncHandler(async (req, res) => {
    const auth = req.auth;
    const applications = await ApplicationModel.find({ applicantUserId: auth.userId }).sort({ createdAt: -1 }).lean();
    return res.json({ applications: applications.map(publicApplication) });
  }));
  router.patch("/:applicationId", asyncHandler(async (req, res) => {
    const auth = req.auth; const application = await ApplicationModel.findOne({ _id: req.params.applicationId, applicantUserId: auth.userId });
    if (!application) return res.status(404).json({ error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." } });
    if (application.status !== "needs_information") throw new OrderWorkflowError(409, "APPLICATION_NOT_EDITABLE", "Only applications requesting more information can be updated.");
    const data = validateData(application.type, req.body?.data);
    const account = await UserModel.findById(auth.userId).select("email phone emailVerified phoneVerified").lean();
    if (!account?.emailVerified || !account?.phoneVerified) throw new OrderWorkflowError(403, "VERIFICATION_REQUIRED", "Verify your email address and phone number before updating an application.");
    data.email = account.email; data.phone = account.phone;
    application.data = data; application.status = "pending_review"; application.feedback = "";
    application.history.push({ status: "pending_review", actorUserId: auth.userId, message: "Applicant resubmitted requested information" });
    await application.save(); return res.json({ application: publicApplication(application) });
  }));
  return router;
}

export function createAdminApplicationsRouter({ ApplicationModel = OnboardingApplication, StoreModel = Store, UserModel = User, AuditModel = AdminAudit, authenticate = requireAuth, authorizeAdmin = requireRoles("admin"), enqueueNotification = enqueueApplicationEmail } = {}) {
  const router = Router(); router.use(authenticate, authorizeAdmin);
  router.get("/", asyncHandler(async (req, res) => {
    const page = validPage(req.query.page), limit = Math.min(100, validLimit(req.query.limit));
    const filter = {};
    if (req.query.type && ["supermarket", "rider"].includes(String(req.query.type))) filter.type = String(req.query.type);
    if (req.query.status && statuses.includes(String(req.query.status))) filter.status = String(req.query.status);
    if (req.query.q) { const q = escapeRegex(String(req.query.q).slice(0, 80)); filter.$or = [{ reference: new RegExp(q, "i") }, { applicantUserId: new RegExp(q, "i") }, { "data.businessName": new RegExp(q, "i") }, { "data.fullName": new RegExp(q, "i") }]; }
    const [rows, total] = await Promise.all([ApplicationModel.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), ApplicationModel.countDocuments(filter)]);
    res.json({ applications: rows.map((row) => publicApplication(row, true)), page, limit, total });
  }));
  router.get("/:applicationId", asyncHandler(async (req, res) => {
    const application = await ApplicationModel.findById(req.params.applicationId).lean();
    if (!application) return res.status(404).json({ error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." } });
    const audit = await AuditModel.find({ targetType: "application", targetId: String(application._id) }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ application: publicApplication(application, true), audit: audit.map(({ actorUserId, action, reason, metadata, createdAt }) => ({ actorUserId, action, reason, metadata, createdAt })) });
  }));
  router.patch("/:applicationId/decision", asyncHandler(async (req, res) => {
    const { decision, reason = "", notes = "" } = req.body || {};
    if (!statuses.slice(1, 5).includes(decision) || typeof reason !== "string" || typeof notes !== "string" || reason.length > 1000 || notes.length > 2000 || ((decision === "rejected" || decision === "needs_information") && !reason.trim())) throw new OrderWorkflowError(400, "INVALID_APPLICATION_DECISION", "Choose under_review, needs_information, approved or rejected. A reason is required for requests and rejections.");
    const auth = req.auth; const application = await ApplicationModel.findById(req.params.applicationId);
    if (!application) return res.status(404).json({ error: { code: "APPLICATION_NOT_FOUND", message: "Application not found." } });
    if (application.status === decision) return res.json({ application: publicApplication(application, true), idempotent: true });
    if (["approved", "rejected", "withdrawn"].includes(application.status)) throw new OrderWorkflowError(409, "APPLICATION_ALREADY_DECIDED", "This application has already been closed.");
    let user = await UserModel.findById(application.applicantUserId);
    if (decision === "approved") {
      if (!user) throw new OrderWorkflowError(404, "APPLICANT_ACCOUNT_NOT_FOUND", "The applicant account no longer exists.");
      if (user.isSuspended) throw new OrderWorkflowError(409, "SUSPENDED_ACCOUNT", "A suspended user cannot be provisioned.");
      if (user.role !== application.type) throw new OrderWorkflowError(409, "ACCOUNT_TYPE_MISMATCH", "The applicant account type no longer matches this application.");
      if (application.type === "supermarket") {
        const slug = `${slugify(application.data.businessName)}-${String(application._id).slice(-6)}`;
        let store = application.provisionedStoreId ? await StoreModel.findById(application.provisionedStoreId) : null;
        if (!store) store = await StoreModel.findOne({ slug });
        if (!store) store = await StoreModel.create({ ownerUserId: String(user._id), name: application.data.businessName, slug, category: application.data.category, description: application.data.description, categories: application.data.categories, address: { line1: application.data.address, city: application.data.city, state: application.data.state, country: "Nigeria", ...(Number.isFinite(application.data.latitude) && Number.isFinite(application.data.longitude) ? { location: { type: "Point", coordinates: [application.data.longitude, application.data.latitude] } } : {}) }, openHours: application.data.operatingHours, isActive: false, isApproved: true, approvalStatus: "approved" });
        application.provisionedStoreId = store._id; user.approvalStatus = "approved"; await user.save();
      } else {
        user.approvalStatus = "approved"; user.riderProfile = { approvalStatus: "approved", vehicleType: application.data.vehicleType || "", isOnline: false, activeDeliveryId: null }; await user.save(); application.provisionedUserId = user._id;
      }
    }
    if (decision === "rejected" && user && user.role === application.type) { user.approvalStatus = "rejected"; if (user.riderProfile) { user.riderProfile.approvalStatus = "rejected"; user.riderProfile.isOnline = false; } await user.save(); }
    application.status = decision; application.active = !["approved", "rejected", "withdrawn"].includes(decision); application.feedback = reason.trim(); application.reviewerNotes = notes.trim(); application.reviewedAt = new Date(); application.history.push({ status: decision, actorUserId: auth.userId, message: reason.trim() }); await application.save();
    await AuditModel.create({ actorUserId: auth.userId, action: `application_${decision}`, targetType: "application", targetId: String(application._id), reason: reason.trim(), metadata: { type: application.type, reference: application.reference, reviewerNotes: notes.trim() } });
    const applicantEmail = user?.email || application.data.email;
    const subject = decision === "approved" ? "Your Go-Shopper application was approved" : decision === "rejected" ? "An update about your Go-Shopper application" : decision === "needs_information" ? "More information is needed for your Go-Shopper application" : "Your Go-Shopper application is under review";
    const body = `Application ${application.reference}: ${decision.replaceAll("_", " ")}.${reason.trim() ? ` Reviewer note: ${reason.trim()}` : ""}`;
    const decisionRound = application.history.filter((entry) => entry.status === decision).length;
    await enqueueNotification({ key: `${application._id}:applicant:${decision}:${decisionRound}`, kind: `application_${decision}`, to: applicantEmail, subject, text: body, html: `<p>${escapeHtml(body)}</p>` }).catch(() => {});
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
function escapeHtml(value) { return String(value || "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]); }

export const applicationsRouter = createApplicationsRouter();
