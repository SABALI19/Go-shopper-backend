import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { errorHandler } from "../middleware/errors.js";
import { createAdminRouter, validateSettings } from "./admin.js";
import { createAdminStoresRouter } from "./adminStores.js";
import { createUsersRouter } from "./users.js";

function query(value) {
  const api = {
    select() { return api; }, sort() { return api; }, skip() { return api; }, limit() { return api; },
    lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
  return api;
}

function makeApp(role = "admin", routers = []) {
  const app = express(); app.use(express.json());
  const authenticate = (req, res, next) => {
    const userId = req.headers.authorization?.replace("Bearer ", "");
    if (!userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in is required" } });
    req.auth = { userId, role: roleFor(userId) }; return next();
  };
  const authorizeAdmin = (req, res, next) => req.auth.role === "admin" ? next() : res.status(403).json({ error: { code: "FORBIDDEN", message: "Admin role required" } });
  for (const { path, router } of routers) app.use(path, router({ authenticate, authorizeAdmin }));
  app.use(errorHandler); return app;
}
function roleFor(id) { return id.startsWith("customer") ? "customer" : id.startsWith("store") ? "supermarket" : "admin"; }
async function request(app, { method = "GET", path, userId = "admin-1", body } = {}) {
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  try { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { ...(userId ? { Authorization: `Bearer ${userId}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, body: await response.json() }; }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("admin endpoints reject unauthenticated, customer, and supermarket users", async () => {
  const app = makeApp("admin", [{ path: "/api/admin", router: createAdminRouter }]);
  assert.equal((await request(app, { path: "/api/admin/settings", userId: null })).status, 401);
  assert.equal((await request(app, { path: "/api/admin/settings", userId: "customer-1" })).status, 403);
  assert.equal((await request(app, { path: "/api/admin/settings", userId: "store-owner-1" })).status, 403);
});

test("settings require integer kobo values, persist changes, and create an audit record", async () => {
  assert.equal(validateSettings({ minimumStoreSubtotalKobo: 900_000, deliveryFeeKobo: 0, serviceFeeKobo: 200 }).error, undefined);
  assert.ok(validateSettings({ minimumStoreSubtotalKobo: 9000.5, deliveryFeeKobo: 0, serviceFeeKobo: 0 }).error);
  assert.ok(validateSettings({ minimumStoreSubtotalKobo: -1, deliveryFeeKobo: 0, serviceFeeKobo: 0 }).error);
  assert.ok(validateSettings({ minimumStoreSubtotalKobo: 10, deliveryFeeKobo: 0, serviceFeeKobo: 0, commission: 3 }).error);
  const audits = []; let saved;
  const SettingsModel = { findById: () => query(null), async findOneAndUpdate(_filter, update) { saved = { ...update.$set }; return saved; } };
  const AuditModel = { async create(record) { audits.push(record); } };
  const app = makeApp("admin", [{ path: "/api/admin", router: (auth) => createAdminRouter({ ...auth, SettingsModel, AuditModel }) }]);
  const result = await request(app, { method: "PUT", path: "/api/admin/settings", body: { minimumStoreSubtotalKobo: 900_000, deliveryFeeKobo: 150_000, serviceFeeKobo: 5_000 } });
  assert.equal(result.status, 200); assert.equal(saved.updatedBy, "admin-1"); assert.equal(audits[0].action, "platform_settings_updated");
  assert.equal((await request(app, { method: "PUT", path: "/api/admin/settings", body: { minimumStoreSubtotalKobo: 0, deliveryFeeKobo: 0, serviceFeeKobo: 0 } })).status, 400);
});

test("store approval, rejection reasons, suspension, reactivation, and audit records are enforced", async () => {
  const store = { _id: "store-id", slug: "fresh", name: "Fresh Mart", isApproved: false, isActive: false, approvalStatus: "pending" };
  const audits = [];
  const StoreModel = {
    findOne: () => query(store),
    async findByIdAndUpdate(_id, update) { Object.assign(store, update.$set); return { ...store, toObject() { return { ...store }; } }; },
  };
  const app = makeApp("admin", [{ path: "/api/stores", router: (auth) => createAdminStoresRouter({ ...auth, StoreModel, AuditModel: { async create(record) { audits.push(record); } } }) }]);
  const denied = await request(app, { method: "PATCH", path: "/api/stores/admin/fresh/approval", userId: "store-owner-1", body: { decision: "approved" } }); assert.equal(denied.status, 403);
  assert.equal((await request(app, { method: "PATCH", path: "/api/stores/admin/fresh/approval", body: { decision: "rejected" } })).status, 400);
  assert.equal((await request(app, { method: "PATCH", path: "/api/stores/admin/fresh/approval", body: { decision: "approved" } })).status, 200);
  const rejectedStore = { _id: "store-rejected-id", slug: "market-two", isApproved: false, approvalStatus: "pending" };
  StoreModel.findOne = (filter) => query(filter.slug === "market-two" ? rejectedStore : store);
  StoreModel.findByIdAndUpdate = async (id, update) => { const target = id === rejectedStore._id ? rejectedStore : store; Object.assign(target, update.$set); return { ...target, toObject() { return { ...target }; } }; };
  assert.equal((await request(app, { method: "PATCH", path: "/api/stores/admin/market-two/approval", body: { decision: "rejected", reason: "Missing registration documents" } })).status, 200);
  assert.equal((await request(app, { method: "PATCH", path: "/api/stores/admin/fresh/status", body: { isActive: false, reason: "Compliance review" } })).status, 200);
  assert.equal(store.isActive, false);
  assert.equal((await request(app, { method: "PATCH", path: "/api/stores/admin/fresh/status", body: { isActive: true } })).status, 200);
  assert.equal(store.isActive, true); assert.deepEqual(audits.map(({ action }) => action), ["store_approved", "store_rejected", "store_suspended", "store_reactivated"]);
});

test("customer account search returns sanitized records and blocks admin suspension", async () => {
  const records = [{ _id: "012345678901234567890123", firstName: "Ada", email: "ada@example.com", role: "customer", isSuspended: false }];
  let receivedFilter;
  const UserModel = { find(filter) { receivedFilter = filter; return query(records); }, countDocuments: async () => 1, findById: () => query(null) };
  const app = makeApp("admin", [{ path: "/api/users", router: (auth) => createUsersRouter({ ...auth, UserModel }) }]);
  const result = await request(app, { path: "/api/users?q=ada&role=customer&status=active" });
  assert.equal(result.status, 200); assert.equal(receivedFilter.role, "customer"); assert.equal(receivedFilter.isSuspended.$ne, true); assert.ok(receivedFilter.$or[2].email instanceof RegExp); assert.equal(result.body.users[0].id, records[0]._id);
});

test("customer suspension requires a reason, is audited, and cannot target admin accounts", async () => {
  const customer = { _id: "012345678901234567890123", firstName: "Ada", role: "customer", isSuspended: false };
  const admin = { _id: "012345678901234567890124", firstName: "Platform", role: "admin", isSuspended: false };
  const audits = [];
  const UserModel = {
    findById(id) { return query(String(id) === customer._id ? customer : admin); },
    async findByIdAndUpdate(id, update) { const user = String(id) === customer._id ? customer : admin; Object.assign(user, update.$set); return { ...user, toObject() { return { ...user }; } }; },
  };
  const app = makeApp("admin", [{ path: "/api/users", router: (auth) => createUsersRouter({ ...auth, UserModel, SessionModel: { async updateMany() { return { modifiedCount: 1 }; } }, AuditModel: { async create(record) { audits.push(record); } } }) }]);
  assert.equal((await request(app, { method: "PATCH", path: `/api/users/admin/${customer._id}/status`, body: { isSuspended: true } })).status, 400);
  assert.equal((await request(app, { method: "PATCH", path: `/api/users/admin/${customer._id}/status`, body: { isSuspended: true, reason: "Abuse report review" } })).status, 200);
  assert.equal(customer.isSuspended, true); assert.equal(audits[0].action, "user_suspended"); assert.equal(audits[0].reason, "Abuse report review");
  assert.equal((await request(app, { method: "PATCH", path: `/api/users/admin/${admin._id}/status`, body: { isSuspended: true, reason: "Test" } })).status, 409);
});

test("admin order list applies reference, payment, status, customer-action and store filters", async () => {
  let receivedFilter; const parent = { _id: "parent-id", orderNumber: "GS-1001", status: "customer_action_required", paymentStatus: "paid", merchandiseSubtotalKobo: 900_000, deliveryFeeKobo: 0, serviceFeeKobo: 0, totalKobo: 900_000 };
  const ParentOrderModel = { find(filter) { receivedFilter = filter; return query([parent]); }, countDocuments: async () => 1 };
  const SubOrderModel = { distinct: async () => [parent._id], find: () => query([]) };
  const StoreModel = { findOne: () => query({ _id: "store-id" }) };
  const app = makeApp("admin", [{ path: "/api/admin", router: (auth) => createAdminRouter({ ...auth, ParentOrderModel, SubOrderModel, StoreModel }) }]);
  const result = await request(app, { path: "/api/admin/orders?q=GS-1001&paymentStatus=paid&status=customer_action_required&customerActionRequired=true&storeId=fresh" });
  assert.equal(result.status, 200); assert.ok(receivedFilter.orderNumber.test("GS-1001")); assert.equal(receivedFilter.paymentStatus, "paid"); assert.equal(receivedFilter.status, "customer_action_required"); assert.deepEqual(receivedFilter._id.$in, [parent._id]);
});

test("admin order detail exposes item exception and refund obligation history read-only", async () => {
  const parent = { _id: "parent-db-id", orderNumber: "GS-1001", customerUserId: "customer-user-id", delivery: { fullName: "Ada", address: "Lagos", phone: "0800" }, merchandiseSubtotalKobo: 900_000, deliveryFeeKobo: 10_000, serviceFeeKobo: 0, totalKobo: 910_000, status: "customer_action_required", paymentStatus: "paid", customerActionHistory: [{ reason: "Customer approval needed", decision: "pending" }], refundObligations: [{ key: "item-1", kind: "item_unavailable", storeName: "Fresh Mart", productName: "Rice", amountKobo: 30_000, status: "pending", reason: "Unavailable", createdAt: new Date() }] };
  const child = { parentOrderId: parent._id, subOrderNumber: "GS-1001-FRESH", storeSlug: "fresh", storeName: "Fresh Mart", items: [{ productKey: "rice", productName: "Rice", quantity: 1, lineTotalKobo: 30_000, unitPriceKobo: 30_000, fulfilmentStatus: "unavailable", unavailableReason: "Out of stock", auditEvents: [{ action: "item_unavailable", actorRole: "supermarket", reason: "Out of stock", createdAt: new Date() }] }] };
  const ParentOrderModel = { findOne: () => query(parent) };
  const SubOrderModel = { find: () => query([child]) };
  const UserModel = { findOne: () => query({ _id: "customer-db", firstName: "Ada", role: "customer" }) };
  const app = makeApp("admin", [{ path: "/api/admin", router: (auth) => createAdminRouter({ ...auth, ParentOrderModel, SubOrderModel, UserModel }) }]);
  const result = await request(app, { path: "/api/admin/orders/GS-1001" });
  assert.equal(result.status, 200); assert.equal(result.body.order.subOrders[0].items[0].unavailableReason, "Out of stock"); assert.equal(result.body.order.subOrders[0].items[0].auditEvents[0].reason, "Out of stock"); assert.equal(result.body.order.refundObligations[0].status, "pending"); assert.equal(result.body.order.customerActionHistory[0].decision, "pending");
});
