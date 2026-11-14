import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { errorHandler } from "../middleware/errors.js";
import { createApplicationsRouter, createAdminApplicationsRouter, validateData } from "./applications.js";

const supermarketData = { businessName: "Market One", legalName: "Market One Limited", fullName: "Sam Shopper", email: "sam@example.com", phone: "+2348012345678", ownershipRole: "owner", ownershipDeclaration: true, category: "Grocery", description: "Neighborhood grocery store", address: "1 Main Road", city: "Lagos", state: "Lagos", operatingHours: "Daily, 8am-9pm" };
function query(value) { return { select() { return this; }, sort() { return this; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; }
function appFor(path, router, role = "customer") { const app = express(); app.use(express.json()); app.use(path, router({ authenticate(req, res, next) { const id = req.headers.authorization?.slice(7); if (!id) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } }); req.auth = { userId: id, role }; next(); }, authorizeAdmin(req, res, next) { return req.auth.role === "admin" ? next() : res.status(403).json({ error: { code: "FORBIDDEN", message: "Admin role required" } }); } })); app.use(errorHandler); return app; }
async function request(app, { method = "GET", path, user = "customer-1", body } = {}) { const server = app.listen(0, "127.0.0.1"); await new Promise(resolve => server.once("listening", resolve)); try { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; } finally { await new Promise(resolve => server.close(resolve)); } }

test("applications require the matching verified account and queue notifications without trusting submitted identity", async () => {
  const records = []; const queued = [];
  const account = { _id: "customer-1", role: "supermarket", isSuspended: false, email: "verified@example.com", emailVerified: true, phone: "+2348012345678", phoneVerified: true, firstName: "Verified", lastName: "Owner" };
  const ApplicationModel = { findOne: () => query(null), async create(value) { const row = { ...value, _id: "application-1", createdAt: new Date() }; records.push(row); return row; } };
  const UserModel = { findById: () => ({ select() { return this; }, lean: () => Promise.resolve(account) }) };
  const app = express(); app.use(express.json()); app.use("/api/applications", createApplicationsRouter({ ApplicationModel, UserModel, authenticate(req, res, next) { const id = req.headers.authorization?.slice(7); if (!id) return res.status(401).json({ error: { code: "UNAUTHORIZED" } }); req.auth = { userId: id }; next(); }, enqueueNotification: async job => { queued.push(job); return { acknowledged: true }; } })); app.use(errorHandler);
  assert.equal((await request(app, { method: "POST", path: "/api/applications/supermarket", user: null, body: { data: supermarketData } })).status, 401);
  assert.equal((await request(app, { method: "POST", path: "/api/applications/rider", body: { data: { fullName: "Sam", email: "sam@example.com", phone: "+2348012345678", address: "Lagos", vehicleType: "bike", operatingArea: "Lagos" } } })).status, 403);
  const result = await request(app, { method: "POST", path: "/api/applications/supermarket", body: { data: { ...supermarketData, email: "spoof@example.com", phone: "+2348099999999", role: "admin" } } });
  assert.equal(result.status, 400); // unknown role field is rejected
  const submitted = await request(app, { method: "POST", path: "/api/applications/supermarket", body: { data: { ...supermarketData, email: "spoof@example.com", phone: "+2348099999999" } } });
  assert.equal(submitted.status, 201); assert.equal(records[0].applicantUserId, "customer-1"); assert.equal(records[0].data.email, account.email); assert.equal(records[0].data.phone, account.phone); assert.equal(submitted.body.confirmationEmailSent, false); assert.equal(submitted.body.notificationQueued, true); assert.equal(queued.length, 2);
  assert.throws(() => validateData("supermarket", { ...supermarketData, ownershipDeclaration: false }), /ownership/i);
});

test("admin approval uses internal owner IDs, provisions one inactive store, and is idempotent", async () => {
  const application = { _id: "app-123456", reference: "GS-S-1", type: "supermarket", applicantUserId: "64b000000000000000000003", status: "pending_review", active: true, data: supermarketData, history: [], save: async function () { return this; } };
  const user = { _id: application.applicantUserId, role: "supermarket", approvalStatus: "pending", emailVerified: true, phoneVerified: true, isSuspended: false, email: "owner@example.com", save: async function () { return this; } };
  const stores = [], audits = [];
  const ApplicationModel = { findById: () => application };
  const UserModel = { findById: id => String(id) === String(user._id) ? user : null };
  const StoreModel = { findOne: () => query(null), async create(value) { const store = { _id: "64b000000000000000000004", ...value }; stores.push(store); return store; }, findById: async () => stores[0] || null };
  const app = express(); app.use(express.json()); app.use("/api/admin/applications", createAdminApplicationsRouter({ ApplicationModel, UserModel, StoreModel, AuditModel: { async create(row) { audits.push(row); } }, authenticate(req, res, next) { req.auth = { userId: "admin-1", role: "admin" }; next(); }, authorizeAdmin(_req, _res, next) { next(); }, enqueueNotification: async () => true })); app.use(errorHandler);
  const path = `/api/admin/applications/${application._id}/decision`;
  const first = await request(app, { method: "PATCH", path, body: { decision: "approved" } });
  const second = await request(app, { method: "PATCH", path, body: { decision: "approved" } });
  assert.equal(first.status, 200); assert.equal(second.body.idempotent, true); assert.equal(stores.length, 1); assert.equal(stores[0].ownerUserId, user._id); assert.equal(stores[0].isActive, false); assert.equal(user.approvalStatus, "approved"); assert.equal(audits.length, 1);
});
