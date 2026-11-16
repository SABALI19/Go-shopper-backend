import assert from "node:assert/strict";
import { test } from "node:test";
import express from "express";
import { createStoresRouter } from "./stores.js";

async function request(app, method, path, body = {}) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const options = { method, headers: { "Content-Type": "application/json" } };
    if (method !== "GET" && method !== "HEAD") options.body = JSON.stringify(body);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

function appWith({ user = { _id: "owner-one", role: "supermarket", approvalStatus: "approved", isSuspended: false }, storeResult = null, stores = [], stockedIds = [], hasAvailableProduct = true } = {}) {
  let lastStoreFilter;
  let updateCalled = false;
  const StoreModel = {
    find(filter) { lastStoreFilter = filter; return { sort() { return this; }, limit() { return this; }, lean: async () => stores }; },
    findOne(filter) { lastStoreFilter = filter; return { select() { return this; }, lean: async () => storeResult }; },
    findOneAndUpdate(filter, update) { lastStoreFilter = filter; updateCalled = true; if (storeResult?.isSuspended && filter.isSuspended?.$ne === true) return Promise.resolve(null); return Promise.resolve(null); },
    async create() { throw new Error("Unexpected store creation"); },
  };
  const ProductModel = {
    async distinct(_field, filter) { assert.equal(filter.isAvailable, true); assert.equal(filter.stockQuantity.$gt, 0); return stockedIds; },
    async exists() { return hasAvailableProduct ? { _id: "available-product" } : null; },
    async create() { throw new Error("Product must not be created for rejected requests"); },
    find() { return { sort() { return this; }, limit() { return this; }, lean: async () => [] }; },
    findOneAndUpdate() { throw new Error("Product must not be updated for rejected requests"); },
  };
  const authenticate = (req, _res, next) => { req.auth = { userId: String(user._id), role: user.role, user }; next(); };
  const app = express(); app.use(express.json()); app.use("/api/stores", createStoresRouter({ StoreModel, ProductModel, authenticate }));
  return { app, getLastStoreFilter: () => lastStoreFilter, wasUpdateCalled: () => updateCalled };
}

test("pending supermarket account cannot mutate its store profile", async () => {
  const { app } = appWith({ user: { _id: "pending-owner", role: "supermarket", approvalStatus: "pending", isSuspended: false } });
  const response = await request(app, "PATCH", "/api/stores/shop-one", { name: "Changed" });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, "APPROVAL_REQUIRED");
});

test("non-supermarket account cannot create a product", async () => {
  const { app } = appWith({ user: { _id: "customer-user", role: "customer", approvalStatus: "approved", isSuspended: false } });
  const response = await request(app, "POST", "/api/stores/shop-one/products", { productKey: "one", name: "Item", priceKobo: 100, stockQuantity: 1 });
  assert.equal(response.status, 403); assert.equal(response.body.error.code, "FORBIDDEN");
});

test("store profile and product mutations cannot cross owner boundaries", async () => {
  const { app, getLastStoreFilter } = appWith({ user: { _id: "owner-two", role: "supermarket", approvalStatus: "approved", isSuspended: false } });
  const response = await request(app, "PATCH", "/api/stores/shop-one/products/product-one", { priceKobo: 250 });
  assert.equal(response.status, 404); assert.equal(getLastStoreFilter().ownerUserId, "owner-two");
  assert.deepEqual(getLastStoreFilter().isSuspended, { $ne: true }); assert.equal(getLastStoreFilter().isApproved, true);
});

test("a store owner cannot reopen or un-suspend a suspended store", async () => {
  const suspended = { _id: "store-one", slug: "shop-one", ownerUserId: "owner-one", isOpen: false, isSuspended: true, isApproved: true };
  const { app, getLastStoreFilter, wasUpdateCalled } = appWith({ storeResult: suspended });
  const response = await request(app, "PATCH", "/api/stores/shop-one", { isOpen: true });
  assert.equal(response.status, 404); assert.equal(wasUpdateCalled(), true);
  assert.deepEqual(getLastStoreFilter().isSuspended, { $ne: true });
  assert.equal(suspended.isOpen, false); assert.equal(suspended.isSuspended, true);
});

test("a store owner cannot submit admin suspension fields", async () => {
  const { app, wasUpdateCalled } = appWith();
  const response = await request(app, "PATCH", "/api/stores/shop-one", { isOpen: true, isSuspended: false });
  assert.equal(response.status, 400); assert.equal(response.body.error.code, "INVALID_STORE_UPDATE"); assert.equal(wasUpdateCalled(), false);
});

test("customer store list returns only approved open unsuspended stores with available stock", async () => {
  const stores = [{ _id: "store-a", slug: "open", isOpen: true, isSuspended: false, isApproved: true }, { _id: "store-b", slug: "empty", isOpen: true, isSuspended: false, isApproved: true }];
  const { app, getLastStoreFilter } = appWith({ stores, stockedIds: ["store-a"] });
  const response = await request(app, "GET", "/api/stores");
  assert.equal(response.status, 200); assert.deepEqual(response.body.stores.map((store) => store.slug), ["open"]);
  assert.equal(getLastStoreFilter().isOpen, true); assert.deepEqual(getLastStoreFilter().isSuspended, { $ne: true }); assert.equal(getLastStoreFilter().isApproved, true);
});

test("customer store detail is hidden when it has no available stock", async () => {
  const store = { _id: "store-a", slug: "empty", isOpen: true, isSuspended: false, isApproved: true };
  const { app } = appWith({ storeResult: store, hasAvailableProduct: false });
  const response = await request(app, "GET", "/api/stores/empty");
  assert.equal(response.status, 404); assert.equal(response.body.error.code, "STORE_NOT_FOUND");
});

test("admin cannot use the supermarket-owned stores endpoint", async () => {
  const { app } = appWith({ user: { _id: "admin-user", role: "admin", approvalStatus: "approved", isSuspended: false } });
  const response = await request(app, "GET", "/api/stores/mine");
  assert.equal(response.status, 403); assert.equal(response.body.error.code, "FORBIDDEN");
});
