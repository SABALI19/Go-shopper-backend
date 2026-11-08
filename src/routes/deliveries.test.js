import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { errorHandler } from "../middleware/errors.js";
import { isValidDeliveryTransition, publicDelivery } from "../features/deliveries/rules.js";
import { createRiderRouter } from "./rider.js";
import { createAdminDeliveriesRouter } from "./adminDeliveries.js";
import { createOrdersRouter } from "./orders.js";
import { createStoreOrdersRouter } from "./storeOrders.js";

function query(value) { const api = { select() { return api; }, sort() { return api; }, skip() { return api; }, limit() { return api; }, session() { return api; }, lean() { return Promise.resolve(value); }, then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); } }; return api; }
function auth(role) { return (req, res, next) => { const userId = req.headers.authorization?.replace("Bearer ", ""); if (!userId) return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Sign in required" } }); req.auth = { userId, role }; next(); }; }
function roles(role) { return (req, res, next) => req.auth?.role === role ? next() : res.status(403).json({ error: { code: "FORBIDDEN", message: "Role denied" } }); }
async function request(app, path, userId) { const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve)); try { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers: userId ? { Authorization: `Bearer ${userId}` } : {} }); return { status: response.status, body: await response.json() }; } finally { await new Promise((resolve) => server.close(resolve)); } }

test("delivery lifecycle permits only explicit next steps", () => {
  assert.equal(isValidDeliveryTransition("assigned", "accepted"), true);
  assert.equal(isValidDeliveryTransition("arrived_at_pickup", "picked_up"), true);
  assert.equal(isValidDeliveryTransition("in_transit", "delivered"), true);
  assert.equal(isValidDeliveryTransition("assigned", "delivered"), false);
  assert.equal(isValidDeliveryTransition("delivered", "failed"), false);
  assert.equal(isValidDeliveryTransition("failed", "in_transit"), false);
});

test("rider API is role protected and scopes delivery reads to the authenticated rider", async () => {
  let observedFilter;
  const DeliveryModel = { find(filter) { observedFilter = filter; return query([{ _id: "delivery-1", assignedRiderClerkUserId: "rider-1", parentOrderNumber: "GS-1", subOrderNumber: "GS-1-1", storeSlug: "store", storeName: "Store", status: "assigned", destination: { fullName: "Customer", address: "Address", phone: "08000000000" } }]); }, countDocuments() { return 1; } };
  const app = express(); app.use("/api/rider", createRiderRouter({ DeliveryModel, authenticate: auth("rider"), authorizeRider: roles("rider") })); app.use(errorHandler);
  const allowed = await request(app, "/api/rider/deliveries", "rider-1");
  assert.equal(allowed.status, 200); assert.equal(observedFilter.assignedRiderClerkUserId, "rider-1");
  assert.equal(allowed.body.deliveries[0].destination.fullName, "Customer");

  const customerApp = express(); customerApp.use("/api/rider", createRiderRouter({ DeliveryModel, authenticate: auth("customer"), authorizeRider: roles("rider") })); customerApp.use(errorHandler);
  assert.equal((await request(customerApp, "/api/rider/deliveries", "customer-1")).status, 403);
  const storeApp = express(); storeApp.use("/api/rider", createRiderRouter({ DeliveryModel, authenticate: auth("supermarket"), authorizeRider: roles("rider") })); storeApp.use(errorHandler);
  assert.equal((await request(storeApp, "/api/rider/deliveries", "store-1")).status, 403);
});

test("admin delivery list returns platform-wide delivery status without proof secrets", async () => {
  const row = { _id: "delivery-1", parentOrderNumber: "GS-1", subOrderNumber: "GS-1-1", storeSlug: "store", storeName: "Store", status: "awaiting_assignment", proofOfDelivery: { codeHash: "secret-hash" } };
  const app = express(); app.use("/api/admin/deliveries", createAdminDeliveriesRouter({ DeliveryModel: { find: () => query([row]), countDocuments: () => 1 }, UserModel: { find: () => query([]) }, authenticate: auth("admin"), authorizeAdmin: roles("admin") })); app.use(errorHandler);
  const response = await request(app, "/api/admin/deliveries", "admin-1");
  assert.equal(response.status, 200); assert.equal(response.body.deliveries.length, 1);
  assert.equal("proofOfDelivery" in response.body.deliveries[0], false);
  const riderApp = express(); riderApp.use("/api/admin/deliveries", createAdminDeliveriesRouter({ DeliveryModel: {}, UserModel: {}, authenticate: auth("rider"), authorizeAdmin: roles("admin") })); riderApp.use(errorHandler);
  assert.equal((await request(riderApp, "/api/admin/deliveries", "rider-1")).status, 403);
});

test("public rider delivery serializer omits customer verification codes", () => {
  const result = publicDelivery({ _id: "d1", status: "in_transit", proofOfDelivery: { codeHash: "secret", codeExpiresAt: new Date() }, history: [] });
  assert.equal(result.status, "in_transit");
  assert.equal("proofOfDelivery" in result, false);
  assert.equal("codeHash" in result, false);
});

test("customer delivery code is owner-scoped and only the hash is persisted", async () => {
  const parent = { _id: "parent-db", paymentStatus: "paid" };
  const delivery = { _id: "0123456789abcdef01234567", parentOrderId: parent._id, customerClerkUserId: "customer-1", status: "in_transit", proofOfDelivery: { codeIssueCount: 0 } };
  let persisted;
  const ParentOrderModel = { findOne: (filter) => query(filter.customerClerkUserId === "customer-1" ? parent : null) };
  const DeliveryModel = {
    findOne: (filter) => query(filter.customerClerkUserId === "customer-1" && filter.parentOrderId === parent._id ? delivery : null),
    async findOneAndUpdate(filter, update) { persisted = update.$set; return { ...delivery, proofOfDelivery: { codeExpiresAt: persisted["proofOfDelivery.codeExpiresAt"] } }; },
  };
  const app = express(); app.use(express.json()); app.use("/api/orders", createOrdersRouter({ ParentOrderModel, DeliveryModel, authenticate: auth("customer"), authorizeCustomer: roles("customer") })); app.use(errorHandler);
  const issued = await requestWithBody(app, "/api/orders/GS-ORDER/deliveries/0123456789abcdef01234567/code", "customer-1");
  assert.equal(issued.status, 200); assert.match(issued.body.code, /^\d{6}$/);
  assert.match(persisted["proofOfDelivery.codeHash"], /^[a-f\d]{64}$/i);
  assert.notEqual(persisted["proofOfDelivery.codeHash"], issued.body.code);
  assert.equal("proofOfDelivery" in issued.body, false);

  const outsider = await requestWithBody(app, "/api/orders/GS-ORDER/deliveries/0123456789abcdef01234567/code", "customer-2");
  assert.equal(outsider.status, 404);
});

async function requestWithBody(app, path, userId, body = {}) {
  const server = app.listen(0, "127.0.0.1"); await new Promise((resolve) => server.once("listening", resolve));
  try { const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: "POST", headers: { Authorization: `Bearer ${userId}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; }
  finally { await new Promise((resolve) => server.close(resolve)); }
}

test("store can hand over only its own ready order to a rider who has arrived", async () => {
  const world = makeHandoverWorld("arrived_at_pickup", "store-1");
  const valid = await requestWithBody(world.app, "/api/stores/alpha/orders/SUB-1/handover", "store-1");
  assert.equal(valid.status, 200); assert.equal(world.state.delivery.status, "picked_up"); assert.equal(world.state.subOrder.status, "dispatched");

  const notArrived = makeHandoverWorld("assigned", "store-1");
  const invalid = await requestWithBody(notArrived.app, "/api/stores/alpha/orders/SUB-1/handover", "store-1");
  assert.equal(invalid.status, 409); assert.equal(notArrived.state.subOrder.status, "ready_for_dispatch");

  const otherOwner = makeHandoverWorld("arrived_at_pickup", "store-owner-2");
  const denied = await requestWithBody(otherOwner.app, "/api/stores/alpha/orders/SUB-1/handover", "store-1");
  assert.equal(denied.status, 404);
});

test("admin assignment requires an available approved rider and records assignment history", async () => {
  const world = makeAssignmentWorld(true);
  const assigned = await requestWithBody(world.app, "/api/admin/deliveries/0123456789abcdef01234567/assign", "admin-1", { riderUserId: "abcdefabcdefabcdefabcdef" });
  assert.equal(assigned.status, 200); assert.equal(world.state.delivery.status, "assigned");
  assert.equal(world.state.rider.riderProfile.activeDeliveryId, world.state.delivery._id);
  assert.equal(world.state.delivery.assignmentHistory[0].action, "assigned");
  const duplicate = await requestWithBody(world.app, "/api/admin/deliveries/0123456789abcdef01234567/assign", "admin-1", { riderUserId: "abcdefabcdefabcdefabcdef" });
  assert.equal(duplicate.status, 409);

  const offline = makeAssignmentWorld(false);
  const rejected = await requestWithBody(offline.app, "/api/admin/deliveries/0123456789abcdef01234567/assign", "admin-1", { riderUserId: "abcdefabcdefabcdefabcdef" });
  assert.equal(rejected.status, 409); assert.equal(offline.state.delivery.status, "awaiting_assignment");
});

function makeAssignmentWorld(isOnline) {
  const state = {
    delivery: { _id: "0123456789abcdef01234567", parentOrderId: "parent-db", parentOrderNumber: "GS-1", subOrderId: "sub-db", subOrderNumber: "SUB-1", storeId: "store-db", storeSlug: "alpha", storeName: "Alpha Store", customerClerkUserId: "customer-1", status: "awaiting_assignment", assignmentHistory: [], history: [] },
    parent: { _id: "parent-db", paymentStatus: "paid" }, child: { _id: "sub-db", storeId: "store-db", status: "ready_for_dispatch" },
    store: { _id: "store-db", isActive: true, isApproved: true, approvalStatus: "approved" },
    rider: { _id: "abcdefabcdefabcdefabcdef", clerkUserId: "rider-1", role: "rider", firstName: "Rider", lastName: "One", phone: "08000000000", isSuspended: false, riderProfile: { approvalStatus: "approved", isOnline, activeDeliveryId: null, vehicleType: "bike" } },
  };
  const connection = { async startSession() { return { async withTransaction(callback) { return callback(); }, async endSession() {} }; } };
  const DeliveryModel = {
    findById: () => ({ session() { return this; }, lean: () => Promise.resolve(state.delivery) }),
    findOneAndUpdate: (_filter, update) => ({ lean: () => { Object.assign(state.delivery, update.$set); state.delivery.assignmentHistory.push(update.$push.assignmentHistory); state.delivery.history.push(update.$push.history); return Promise.resolve(state.delivery); } }),
  };
  const UserModel = {
    findOne: (filter) => query(filter.clerkUserId ? state.rider : state.rider),
    updateOne: (filter, update) => { if (filter._id && !state.rider.riderProfile.isOnline) return Promise.resolve({ modifiedCount: 0 }); Object.assign(state.rider.riderProfile, { activeDeliveryId: update.$set["riderProfile.activeDeliveryId"], isOnline: update.$set["riderProfile.isOnline"] }); return Promise.resolve({ modifiedCount: 1 }); },
  };
  const ParentOrderModel = { findOne: () => ({ session() { return this; }, lean: () => Promise.resolve(state.parent) }) };
  const SubOrderModel = { findOne: () => ({ session() { return this; }, lean: () => Promise.resolve(state.child) }) };
  const StoreModel = { findOne: () => ({ session() { return this; }, lean: () => Promise.resolve(state.store) }) };
  const AuditModel = { create: async () => [] };
  const app = express(); app.use(express.json()); app.use("/api/admin/deliveries", createAdminDeliveriesRouter({ DeliveryModel, ParentOrderModel, SubOrderModel, StoreModel, UserModel, AuditModel, connection, authenticate: auth("admin"), authorizeAdmin: roles("admin") })); app.use(errorHandler);
  return { app, state };
}

function makeHandoverWorld(deliveryStatus, owner) {
  const state = {
    store: { _id: "store-db", slug: "alpha", name: "Alpha Store", ownerClerkUserId: owner, isActive: true, isApproved: true, approvalStatus: "approved" },
    parent: { _id: "parent-db", orderNumber: "GS-1", customerClerkUserId: "customer-1", paymentStatus: "paid", status: "processing", delivery: { fullName: "Customer", address: "Address", phone: "08000000000" } },
    subOrder: { _id: "sub-db", subOrderNumber: "SUB-1", parentOrderId: "parent-db", storeId: "store-db", storeSlug: "alpha", storeName: "Alpha Store", status: "ready_for_dispatch", items: [{ productKey: "rice", productName: "Rice", quantity: 1, lineTotalKobo: 900000, fulfilmentStatus: "fulfilled" }] },
    delivery: { _id: "0123456789abcdef01234567", subOrderId: "sub-db", parentOrderId: "parent-db", storeId: "store-db", assignedRiderClerkUserId: "rider-1", status: deliveryStatus, history: [] },
  };
  const connection = { async startSession() { return { async withTransaction(callback) { return callback(); }, async endSession() {} }; } };
  const StoreModel = { find: () => query([state.store]) };
  const ParentOrderModel = { findById: () => ({ session() { return this; }, lean: () => Promise.resolve(state.parent) }) };
  const SubOrderModel = {
    findOne: () => ({ session() { return this; }, lean: () => Promise.resolve(state.subOrder) }),
    findOneAndUpdate: (_filter, update) => ({ lean: () => { Object.assign(state.subOrder, update.$set); return Promise.resolve(state.subOrder); } }),
  };
  const DeliveryModel = {
    findOne: () => ({ session() { return this; }, lean: () => Promise.resolve(state.delivery) }),
    findOneAndUpdate: (_filter, update) => ({ lean: () => { Object.assign(state.delivery, update.$set); state.delivery.history.push(update.$push.history); return Promise.resolve(state.delivery); } }),
  };
  const app = express(); app.use(express.json());
  app.use("/api/stores", createStoreOrdersRouter({ StoreModel, ParentOrderModel, SubOrderModel, DeliveryModel, connection, authenticate: auth("supermarket"), authorizeSupermarket: roles("supermarket"), roleProvider: async () => "supermarket" })); app.use(errorHandler);
  return { app, state };
}
